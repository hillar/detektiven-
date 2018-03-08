const fs = require('fs')
const path = require('path')
const net = require('net')
const http = require('http')
const https = require('https')
const request = require('request')
const nodemailer = require('nodemailer')
const ldap = require('ldapjs')

function guid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
  }
  return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}

function now(){
  const now = new Date()
  return now.toJSON()
}

function date2JSON(v){
  const tmp = parseInt(v)
  if (! isNaN(tmp) ) {
    const d = new Date(tmp)
    if (isNaN(d.getTime())) return false
    else return d.toJSON()
  } else {
    const d = new Date(v)
    if (isNaN(d.getTime())) return false
    else return d.toJSON()
  }
}

function logError(error){
  const time = now()
  console.error(JSON.stringify({time, error}))
}

function logInfo(info){
  const time = now()
  if (process.stdout.isTTY) console.log(JSON.stringify({time, info}))
}

function logNotice(notice){
  const time = now()
  console.log(JSON.stringify({time, notice}))
}

function logWarning(warning){
  const time = now()
  console.log(JSON.stringify({time, warning}))
}

async function ensureDirectory(directory){
  return new Promise((resolve, reject) => {
    const func = 'ensureDirectory'
    const testFile = path.join(directory,'test_______.txt')
    if (!fs.existsSync(directory)) {
      try {
        fs.mkdirSync(directory)
        fs.writeFileSync(testFile,'test123456')
        fs.unlinkSync(testFile)
        resolve(true)
      } catch (error) {
        const msg = error.message
        logError({func,directory,msg})
        resolve(false)
      }
    } else {
      try {
        fs.writeFileSync(testFile,'test123456')
        fs.unlinkSync(testFile)
        resolve(true)
      } catch (error) {
        const msg = error.message
        logError({func,directory,msg})
        resolve(false)
      }
    }
  })
}

async function readFile(filename){
  return new Promise((resolve, reject) => {
    try {
      let data = fs.readFileSync(filename)
      resolve(data)
    } catch (error) {
      const func = 'readFile'
      const msg = error.message
      logWarning({func,filename,msg})
      resolve(false)
    }
  })
}
async function writeFile(filename,data){
  return new Promise((resolve, reject) => {
    try {
      fs.writeFileSync(filename,data)
      resolve(true)
    } catch (error) {
      const func = 'writeFile'
      const msg = error.message
      logError({func,filename,msg})
      resolve(false)
    }
  })
}

function checkHostPortConnection(host, port, timeout) {
    return new Promise(function(resolve, reject) {
        timeout = timeout || 1000
        var timer = setTimeout(function() {
            socket.end()
            reject(new Error('timeout '+timeout))
        }, timeout)
        var socket = net.createConnection(port, host, function() {
            clearTimeout(timer)
            socket.end()
            resolve(true)
        })
        socket.on('error', function(err) {
            clearTimeout(timer)
            reject (err)
        })
    })
}
async function pingServer(service,host,port){
  return new Promise(function(resolve, reject) {
    checkHostPortConnection(host,port)
    .then(function(){
      logInfo({'ping':'OK',service,host,port})
      resolve(true)
    })
    .catch(function(err){
      let error = err.message
      logInfo({'ping':'FAILED',service,host,port,error})
      resolve(false)
    })
  })
}

function getIpUser(req){
  let username = req.user || false
  let ip = req.socket.remoteAddress
  if (req.headers['x-real-ip']) ip = req.headers['x-real-ip']
  if (req.headers['x-public-ip']) ip = req.headers['x-public-ip']
  /*
  'x-client-ssl-serial': '3..',
  */
  return {ip, username}
}

async function httpGet(proto, host, port, path, body){
  return new Promise((resolve, reject) => {
    if (!host) reject(new Error('httpGet no host'))
    if (!port) reject(new Error('httpGet no port'))
    if (!path) reject(new Error('httpGet no path'))
    const start = Date.now()
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    logInfo({'httpGet':'start',proto, host, port, path, body})
    try {
      const contentlength = ( (body) ? Buffer.byteLength(body) : 0 )
      const options = {
        hostname: host,
        port: port,
        path: path,
        method: 'GET',
        headers: {
          'content-type' : 'application/json; charset=UTF-8',
          'content-length' : contentlength
        }
      };
      const req = (proto === 'https' ? https : http).request(options, (res) => {
        res.setEncoding('utf8');
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          logInfo({'httpGet':'end', 'took':Date.now() - start, proto, host, port, path, body})
          resolve(data)
        });
        res.on('error', (error) => {
          logWarning({'httpGet':'res error', error})
          reject(error)
        })
      });
      req.on('error', (error) => {
        reject(error)
      });
      if (body) req.write(body);
      req.end();
    } catch (error) {
      logError({'httpGet':'try error', error})
      reject(error)
    }
  })
}

async function httpPost(proto, host, port, path,filename,fields){
  return new Promise((resolve, reject) => {
    if (!host) reject(new Error('httpPost no host'))
    if (!port) reject(new Error('httpPost no port'))
    if (!path) reject(new Error('httpPost no path'))
    if (!filename) reject(new Error('httpPost no filename'))
    const start = Date.now()
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    let formData = {file: fs.createReadStream(filename)}
    if (fields) for (const field of Object.keys(fields).sort()){
      if (fields[field]) formData[field] = fields[field]
    }
    const url = `${(proto === 'https' ? 'https' : 'http')}://${host}:${port}/${path}`
    logInfo({'httpPost':'start',proto, host, port, path, filename,url})
    try {
      request.post({url:url, formData: formData}, function cb(err, httpResponse, body) {
        if (err) {
          logWarning({'httpPost':'request error', error:err.message})
          reject(err);
        }
        resolve(body)
      });
    } catch (error) {
      logWarning({'httpPost':'try error', error})
      reject(error)
    }
  })
}

function sendMail(to, subject, body, from, host, port) {
  return new Promise((resolve, reject) => {
    const func = 'sendMail'
    const transport = nodemailer.createTransport({host:host, port:port,tls: {rejectUnauthorized: false}})
    transport.sendMail({from:from, to:to, subject:subject, text:body },(err, info) => {
        if (err) {
          const error = err.message
          logWarning({func,'status':'mail not sent',error})
          resolve(false)
        } else {
          logInfo({func,'status':'mail sent',info})
          resolve(true)
        }
      })
  })
}

function ldapBindandFind(server,base,binduser,bindpass,field,user,pass,group){
  return new Promise((resolve, reject) => {
    const func = 'ldapBindandFind'
    try {
      let client = ldap.createClient({url: `ldaps://${server}`, tlsOptions: {rejectUnauthorized: false}})
      client.on('error',function(err){
        logWarning({func,'clientError':err.message})
        resolve(false)
      })
      client.bind(`uid=${binduser},cn=users,${base}`,bindpass,function(err){
        if (err) {
          logWarning({func,'bindError':err.message})
          resolve(false)
        } else {
          let opts = { filter: `(&(${field}=${user})(memberof=cn=${group},cn=groups,${base}))`, scope: 'sub'};
          //logInfo({'ldap':'binded', opts})
          client.search(base,opts,function(err, res) {
            if (err) {
              logWarning({func,'searchError':err.message})
              resolve(false)
            } else {
              let entries = []
              res.on('searchEntry', function(entry) {
                entries.push(entry.object)
              });
              res.on('error', function(err) {
                resolve(false)
              });
              res.on('end', function(result) {
                //logInfo({'end':entries})
                if (entries.length === 1) {
                    resolve(entries[0])
                } else {
                  if (entries.length === 0 ) logInfo({'notfound':{user,group}})
                  else logError({'shouldNotHappen':user +' to many entiries ' + entries.length })
                  resolve(false)
                }
              });
            }
          })
        }
      })
  } catch (err) {
    logError({func,'error':err.message})
    resolve(false);
  }
  })
}

async function getUser(server,base,binduser,bindpass,field,user,pass,group){
  let a = await ldapBindandFind(server,base,binduser,bindpass,field,user,pass,group)
  if (!a) return false
  let b = await ldapBindandFind(server,base,a.uid,pass,'uid',user,null,group)
  if (!b) return false
  let u = {}
  u['uid'] = b.uid
  u['cn'] = b.cn
  u['mail'] = (Array.isArray(b.mail) ? b.mail.join('; '):  b.mail)
  u['employeeNumber'] = b.employeeNumber
  u['memberOf'] = []
  let tmp = b.memberOf.filter(g => g.indexOf(',cn=groups,') > -1)
  for (let i in tmp){
    u['memberOf'].push(tmp[i].split(',')[0].split('=')[1])
  }

  return u
}

module.exports = {
  guid: guid,
  now: now,
  date2JSON: date2JSON,
  logNotice: logNotice,
  logWarning: logWarning,
  logError: logError,
  readFile: readFile,
  writeFile: writeFile,
  ensureDirectory: ensureDirectory,
  pingServer: pingServer,
  sendMail: sendMail,
  getUser: getUser,
  httpGet: httpGet,
  httpPost: httpPost,
  getIpUser: getIpUser,
  readJSON: async function(filename){
    let data = await readFile(filename)
    if (data === false) {
        return false
    } else {
        try {
          let json = JSON.parse(data)
          return json
        } catch (error) {
          const func = 'readJSON'
          const msg = error.message
          logError({func,filename,msg})
          return false
        }
    }
  }
}
