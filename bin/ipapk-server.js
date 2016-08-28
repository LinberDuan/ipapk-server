#!/usr/bin/env node

var fs = require('fs-extra');
var https = require('https');
var path = require('path');
var exit = process.exit;
var pkg = require('../package.json');
var version = pkg.version;

var program = require('commander');
var express = require('express');
var mustache = require('mustache');
var strftime = require('strftime');
var underscore = require('underscore');
var AdmZip = require('adm-zip');
var AppBundleInfo = require('app-bundle-info');
var os = require('os');
require('shelljs/global');

/** 格式化输入字符串**/

//用法: "hello{0}".format('world')；返回'hello world'

String.prototype.format= function(){
  var args = arguments;
  return this.replace(/\{(\d+)\}/g,function(s,i){
    return args[i];
  });
}

var ipAddress = underscore
  .chain(require('os').networkInterfaces())
  .values()
  .flatten()
  .find(function(iface) {
    return iface.family === 'IPv4' && iface.internal === false;
  })
  .value()
  .address;


var globalCerFolder = os.homedir() + '/.ipapk-server/' + ipAddress;
/**
 * Main program.
 */
process.exit = exit

// CLI

before(program, 'outputHelp', function() {
  this.allowUnknownOption();
});

program
  .version(version)
  .usage('[option] [dir]')
  .option('-p, --port <port-number>', 'set port for server (defaults is 1234)')
  .parse(process.argv);

var port = program.port || 1234;
var basePath = "https://{0}:{1}".format(ipAddress, port);
if (!exit.exited) {
  main();
}

/**
 * Install a before function; AOP.
 */

function before(obj, method, fn) {
  var old = obj[method];

  obj[method] = function() {
    fn.call(this);
    old.apply(this, arguments);
  };
}

function main() {

  console.log(basePath);
  var destinationPath = program.args.shift() || '.';
  var serverDir = destinationPath;
  var ipasDir = serverDir + "/ipa";
  var apksDir = serverDir + "/apk";

  var key;
  var cert;

  try {
    key = fs.readFileSync(globalCerFolder + '/mycert1.key', 'utf8');
    cert = fs.readFileSync(globalCerFolder + '/mycert1.cer', 'utf8');
  } catch (e) {
    var result = exec('sh  ' + path.join(__dirname, '..', 'generate-certificate.sh') + ' ' + ipAddress).output;
    key = fs.readFileSync(globalCerFolder + '/mycert1.key', 'utf8');
    cert = fs.readFileSync(globalCerFolder + '/mycert1.cer', 'utf8');
  }

  var options = {
    key: key,
    cert: cert
  };

  var app = express();
  app.use('/public', express.static(path.join(__dirname, '..', 'public')));
  app.use('/cer', express.static(globalCerFolder));

  app.get(['/ipa/:app', '/apk/:app'], function(req, res) {
    var filename;
    if (path.extname(req.params.app) === '.apk') {
      filename = apksDir + '/' + req.params.app;
    } else {
      filename = ipasDir + '/' + req.params.app;
    }

    // This line opens the file as a readable stream
    var readStream = fs.createReadStream(filename);

    // This will wait until we know the readable stream is actually valid before piping
    readStream.on('open', function() {
      // This just pipes the read stream to the response object (which goes to the client)
      readStream.pipe(res);
    });

    // This catches any errors that happen while creating the readable stream (usually invalid names)
    readStream.on('error', function(err) {
      res.end(err);
    });
  });

  app.get(['/', '/download/:app'], function(req, res, next) {

    fs.readFile(path.join(__dirname, '..', 'templates') + '/download.html', function(err, data) {
      if (err) throw err;
      var template = data.toString();
      var items;
      if (req.params.app === 'apk') {
        items = apksInLocation(apksDir);
      }
      else  {
        items = ipasInLocation(ipasDir);
      }
      items = items.map(function(item) {
        return appInfoWithName(item);
      });
      Promise.all(items).then(function(result) {
        var itemInfos = result.sort(function(a, b) {
          var result = b.time.getTime() - a.time.getTime();
          // if (result > 0) {result = 1} else if (result < 0) { result = -1 };
          return result;
        });
        var info = {};
        info.basePath = basePath;
        info.items = itemInfos;
        var rendered = mustache.render(template, info);
        res.send(rendered);
      });
    })
  });

  app.get('/plist/:file', function(req, res) {
    fs.readFile(path.join(__dirname, '..', 'templates') + '/template.plist', function(err, data) {
      if (err) throw err;
      var template = data.toString();
      var rendered = mustache.render(template, {
        name: req.params.file,
        basePath: basePath,
      });
      res.set('Content-Type', 'text/plain; charset=utf-8');
      // res.set('MIME-Type', 'application/octet-stream');
      res.send(rendered);
    })
  });

  https.createServer(options, app).listen(port);

}

function appInfoWithName(filename) {
  return new Promise(function(resolve, reject){
    var stat = fs.statSync(filename);
    var time = new Date(stat.mtime);
    var timeString = strftime('%F %H:%M', time);
    var iconUrl;
    var url;
    var name = path.basename(filename, path.extname(filename));
    if (path.extname(filename) === '.ipa') {
      iconUrl = "{0}/icon/ipa/{1}".format(basePath, name);
      url = "itms-services://?action=download-manifest&url={0}/plist/{1}".format(basePath, name);
    } else {
      iconUrl = "{0}/icon/apk/{1}".format(basePath, name);
      url = "{0}/apk/{1}.apk".format(basePath, name);
    }
    resolve({
      name: name,
      description: '更新: ' + timeString,
      time: time,
      iconUrl: iconUrl,
      url: url,
    })
  });
//   var apkStream = fs.readFileSync(filename);
//     AppBundleInfo.autodetect(filename,function(err,bundleInfo){
//       // console.log(err);
// //       bundleInfo.getIconFile(function(err,iconStream){
// //     iconStream.pipe(fs.createWriteStream('icon.png'));
// // });
//       bundleInfo.loadInfo(function(err,information){
//         console.log(information);
//     });
//       console.log('getted');
// });
}

function ipasInLocation(location) {
  return filesInLocation(location,'.ipa');
}

function apksInLocation(location) {
  return filesInLocation(location,'.apk');
}

function filesInLocation(location,type) {
  var result = [];
  var files = fs.readdirSync(location);
  for (var i in files) {
    if (path.extname(files[i]) === type) {
      result.push(path.join(location, files[i]));
    }
  }
  return result;
}