#!/usr/bin/env node
const os = require('os')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const lzma = require('lzma-native')
const cliParams = require('commander')
const http = require('http')
const auth = require('http-auth')
const Busboy = require('busboy')
const base64url = require('base64url')
const querystring = require('querystring')
const { nowAsJSON, date2JSON } = require('./common/time.js')
const { ensureDirectory, writeFile, readFile, readJSON, isFile, getMime } = require('./common/fs.js')
const { logError, logWarning, logNotice, logCritical } = require('./common/log.js')
const { getIpUser } = require('./common/request.js')
const { guid } = require('./common/var.js')
const { httpGet, httpPost, pingServer } = require('./common/net.js')
const { getUser } = require('./common/freeipa.js')
const { sendMail } = require('./common/mail.js')

//const { guid, now, date2JSON, logNotice, logWarning, logError, ensureDirectory, readFile, writeFile, readJSON, pingServer, sendMail, getUser, httpGet, httpPost, getIpUser } = require('./utils')

async function main() {

const MAXRESULTS = 1024

cliParams
  .version('0.0.1')
  .usage('[options]')
  .option('-c, --config [file]', 'config file','./config.json')
  .option('-g, --generate-config ', 'generate sample config file')
  .option('-t, --test','test connections')
  .option('--port [number]','port to listen')
  .option('--ip [ip address]','ip to bind')
  .option('--static [path]','static files to serve')
  .option('--users-file [file]','users sessions full path file name')
  .option('--upload-directory [path]','upload path')
  .option('--subscriptions-directory [path]','subscriptions path')
  .option('--smtp-host [host]','smtp host')
  .option('--smtp-port [number]','smtp port')
  .option('--smtp-sender [email]','smtp sender')
  .option('--ipa-server [host]','freeipa server (or any other ldap)')
  .option('--ipa-base [string]','ldap base')
  .option('--ipa-binduser [string]','ldap bind user')
  .option('--ipa-bindpass [string]','ldap bind password')
  .option('--ipa-usergroup [string]','user group')
  .parse(process.argv);

  // load config file
  var configFile = {}
  if (!cliParams.generateConfig){
    configFile = await readJSON(cliParams.config)
    if (configFile === false ) {
      if (process.stdout.isTTY) console.log('failed to load config file, try -g to generate sample config')
      process.exit(1);
    }
  }
  // override config with cmd params
  let config = {}
  config.portListen = cliParams.port || configFile.port || '9983'
  config.ipBind = cliParams.ip || configFile.ipBind || '127.0.0.1'
  config.usersFile = cliParams.usersFile || configFile.usersFile || '/tmp/osse/users.json'
  config.uploadDirectory = cliParams.uploadDirectory || configFile.uploadDirectory || '/tmp/osse/uploads'
  config.subscriptionsDirectory = cliParams.subscriptionsDirectory || configFile.subscriptionsDirectory || '/tmp/osse/subscriptions'
  config.staticDirectory = cliParams.static || configFile.staticDirectory || '/tmp/osse/dist'
  config.smtpfrom = cliParams.smtpSender || configFile.smtpSender || 'noreply-osse@localhost'
  config.smtphost = cliParams.smtpHost || configFile.smtpHost || '127.0.0.1'
  config.smtpport = cliParams.smtpPort || configFile.smtpPort || 25
  config.ipaServer = cliParams.ipaServer || configFile.ipaServer || '127.0.0.1'
  config.ipaBase = cliParams.ipaBase || configFile.ipaBase || 'cn=accounts,dc=example,dc=org'
  config.ipaBindpass = cliParams.ipaBindpass || configFile.ipaBindpass || 'password'
  config.ipaBinduser = cliParams.ipaBinduser || configFile.ipaBinduser || 'username'
  config.ipaUsergroup = cliParams.ipaUsergroup || configFile.ipaUsergroup || 'osse'
  config.ipaUserField = cliParams.ipaUserField || configFile.ipaUserField || 'uid'
  config.realm = configFile.realm || 'osse'
  config.reauth = configFile.reauth || 1000 * 60
  config.metaFilename = configFile.metaFilename || 'meta.json'
  config.subscriptionsFilename = configFile.subscriptionsFilename || 'subscriptions.json'
  config.etlMapping = configFile.etlMapping || 'file:///'
  config.md5Fieldname = configFile.md5Fieldname || 'file_md5_s'
  config.uploadFileServer = configFile.uploadFileServer || '127.0.0.1'
  config.uploadFileServerProto = configFile.uploadFileServerProto || 'http'
  config.filesPort = configFile.filesPort || 8125
  config.uploadUser = cliParams.uploadUser || configFile.uploadUser || 'uploadonly'
  config.servers = configFile.servers || [{"HR":"hardCodedDefault","type":"solr","proto":"http","host":"localhost","port":8983,"collection":"solrdefalutcore","rotationperiod":"none"},{"HR":"hardCodedDefaultElastic","type":"elastic","proto":"http","host":"localhost","port":9200,"collection":"osse","rotationperiod":"yearly"}]
  // generate sample configFile
  if (cliParams.generateConfig) {
    console.log(JSON.stringify(config, null, 2))
    process.exit(0);
  }
  //start with notice
  if (process.stdout.isTTY) console.log(JSON.stringify({'msg':'starting',config}, null, 4))
  else   logNotice({'msg':'starting',config})
  // test paths
  let usersFileDir = await ensureDirectory(path.dirname(config.usersFile))
  if (!usersFileDir) process.exit(1)
  let uploadDirectory = await ensureDirectory(config.uploadDirectory)
  if (!uploadDirectory) process.exit(1)
  let subscriptionsDirectory = await ensureDirectory(config.subscriptionsDirectory)
  if (!subscriptionsDirectory) process.exit(1)

  // test connection to ipa,smtp and servers
  if (cliParams.test) {
    if (await pingServer('ipa',config.ipaServer,389)) {
      let u = await getUser(config.ipaServer,config.ipaBase,config.ipaBinduser,config.ipaBindpass,config.ipaUserField,config.ipaBinduser,config.ipaBindpass,config.ipaUsergroup)
      if (u) logNotice({u})
    }
    if (await pingServer('smtp',config.smtphost,config.smtpport)) await sendMail(config.smtpfrom, 'test','1234', config.smtpfrom, config.smtphost, config.smtpport)
    await pingServer('fileserver',config.uploadFileServer,config.filesPort)
    for (let i in config.servers){
      let server = config.servers[i]
      //if (!server.type) reject(new Error('no server type'))
      await pingServer(server.HR,server.host,server.port)
      await pingServer(server.HR,server.host,config.filesPort)
    }
    process.exit(0);
  }

  let users = await readJSON(config.usersFile)
  if (users === false ) {
    users = {}
    if (process.stdout.isTTY) console.log('fresh start !?, no users sessions history file',config.usersFile)
  }

  let basic = auth.basic({
  		realm: config.realm
  	}, async (username, password, callback) => {
  		// do not reauth in X milliseconds
      if (username === config.uploadUser && password === config.uploadUser) callback(true)
      // do not reauth in X milliseconds
  		if (users[username] && users[username]['lastseen'] && (Date.now() - users[username]['lastseen'] < config.reauth)){
  			 callback(true)
  		} else {
  			//TODO get employeeNumber from header
          let user = await getUser(config.ipaServer,config.ipaBase,config.ipaBinduser,config.ipaBindpass,config.ipaUserField,username,password,config.ipaUsergroup)
  	 		  if (user && username === user.uid) {
  					if (!users[username]) {
  						users[username] = {}
  						logNotice({'firstLogin':username})
  					}
  					users[username]['ipa'] = user
  					users[username]['logintime'] = Date.now()
            sendMail(user.mail, 'Welcome', `Welcome ${user.cn} !` , config.smtpfrom, config.smtphost, config.smtpport)
  					callback(true);
  				} else {
            if (user) {
  					    logWarning({'uidMismatch':{username,'uid':user.uid}})
  					    callback(false);
            } else {
                callback(false);
            }
  				}
  		}
  	}
  );
  basic.on('success', (result, req) => {
    const { ip, username } = getIpUser(req)
    if (!users[result.user]){
      users[result.user] = {'logintime':Date.now(), 'lastseen':Date.now(), ip}
    } else {
      users[result.user]['lastseen'] = Date.now()
      if (users[result.user]['ip'] && ip != users[result.user]['ip']) {
        logNotice({'newIP':ip})
        sendMail(users[result.user].ipa.mail, 'new ip', 'new login from '+ ip, config.smtpfrom, config.smtphost, config.smtpport)
      }
    }
    writeFile(config.usersFile,JSON.stringify(users))
    let user_online = users[result.user]['lastseen'] - users[result.user]['logintime']
  });
  basic.on('fail', (result, req) => {
    const { ip, username } = getIpUser(req)
    if (users[result.user]) {
      delete users[result.user]
      writeFile(config.usersFile,JSON.stringify(users))
      logNotice({'authBasic':'removing user '+ result.user})
    }
    logWarning({'authBasic':'fail',ip,'username':result.user})
  });
  basic.on('error', (error, req) => {
    logWarning({'authBasic':error})
  });


// ------------------------

function compress2Base64Url(s){
  return new Promise( resolve => {
    try {
      lzma.compress(s, 9, function(result){
        const b = base64url.encode(result)
        //chop xz header
        //_Td6WFoAAAFpIt42AgAhARwAAAAQz1j
        const c = b.slice(32)
        resolve(c)
      })
    } catch (error) {
      try {
        lzma.compress(s, 5, function(result){
          const b = base64url.encode(result)
          //chop xz header
          //_Td6WFoAAAFpIt42AgAhARwAAAAQz1j
          const c = b.slice(32)
          resolve(c)
        })
      } catch (error) {
        logCritical({compress2Base64Url:error.message})
        resolve(s)
      }
    }
  })
}

function decompress2Base64Url(s){
  return new Promise( resolve => {
    const b = '_Td6WFoAAAFpIt42AgAhARwAAAAQz1jM' + s
    const c = base64url.toBuffer(b)
    lzma.decompress(c, function(result){
      if (result !== null) {
        resolve(result.toString())
      } else {
        resolve('')
      }
    })
  })
}

function createGets(args,servers,singleServer){
  let httpgets = []
  for (const server of servers){
    //let server = config.servers[i]
    if (!singleServer || singleServer === server.HR) httpgets.push(new Promise((resolve, reject) => {
      let query = ''
      switch (server.type) {
        case 'solr':
          query += '/solr/'+server.collection+'/select?'
          //if (!args.wt)
          args.wt = 'json'
          query += 'wt='+args.wt+'&q=' + args.q.trim() + '&'
          if (args.q_op && args.q_op === 'AND') query += 'q.op=AND&'
          //if (args.sort)
          query +='sort=score%20desc&'
          query += 'rows='+args.rows+'&start='+args.start+'&'
          if (args.fl) query += 'fl='+args.fl+'&'
          if (args.hl) {
             query += 'hl=on&'
             for (let hl in args.hl) {
               query += 'hl.'+hl+'='+args.hl[hl]+'&'
             }
          }
          httpGet(server.proto,server.host,server.port,query)
          .then(function(result){
            try {
              let resJson = JSON.parse(result)
              if (resJson.error) {
                let responseHeader = resJson.responseHeader
                logError({responseHeader})
                let error = new Error(resJson.error.msg)
                resolve({server,error})
              } else {
                if (resJson.highlighting){
                  resolve({server,'result':resJson.response,'highlighting':resJson.highlighting})
                } else resolve({server,'result':resJson.response})
              }
            } catch (e) {
                logError({try233:e.message})
                resolve({server})
            }
          })
          .catch(function(error){
            resolve({server,error})
          })
          break
        case 'elastic':
        case 'elasticsearch':
            // http://nocf-www.elastic.co/guide/en/elasticsearch/reference/current/search-uri-request.html
            // https://www.elastic.co/guide/en/elasticsearch/reference/current/mapping-id-field.html
            if (args.q.indexOf('id%3A') !== -1) args.q = args.q.replace('id%3A','_id%3A')
            query += '/'+server.collection+'/_search?track_scores&lenient&q=' + args.q + '&'
            query += 'size='+args.rows+'&from='+args.start+'&'
            query += '_source_include='+args.fl+'&'
            let body
            if (args.hl) {
              // https://www.elastic.co/guide/en/elasticsearch/reference/current/search-request-highlighting.html
              body = `{"highlight":{"fields":{"${args.hl.fl}":{"fragment_size":${args.hl.fragsize},"number_of_fragments":${args.hl.snippets}}}}}}`
            }
            httpGet(server.proto,server.host,server.port,query,body)
            .then(function(res){
              try {
                let resElastic = JSON.parse(res)
                if (resElastic.error){
                    logWarning({'error':resElastic.error,query,server})
                    resolve({server})
                } else {
                  if (resElastic.hits) {
                    let docs = []
                    while (resElastic.hits.hits.length>0) {
                      let tmp = resElastic.hits.hits.pop()
                      let doc = tmp._source
                      doc.id = tmp._id
                      doc.score = tmp._score
                      if (doc.content) doc.content = [doc.content]
                      if (tmp.highlight && tmp.highlight.content) doc['_highlighting_'] = tmp.highlight.content
                      docs.push(doc)
                    }
                    resolve({server,'result':{'numFound':resElastic.hits.total,'docs':docs}})
                  } else {
                    logError({'error':'no hits and no error',query,server})
                    resolve({server})}
                }
              } catch (e) {
                let error = e.message
                logError({error,query,server})
                resolve({server})
              }
            })
            .catch(function(error){
              resolve({server,error})
            })
        break
        default:
          logError({'msg':'not supported ' + server.type,server})
          resolve({server})
      }
    }))
  }
  return httpgets
}



// -------------------------

let osse = http.createServer(basic, async (req, res) => {
//let osse = http.createServer( async (req, res) => {

    if (req.url.indexOf('/select?q=*:*&wt=csv&rows=0&facet') > -1 ) req.url = '/fields'
    let bittes = req.url.split('?')
    let urlPath = bittes[0]
    let leftpath = '/'+bittes[0].split('/')[1] || '/'
    const route = req.method + leftpath
    let rightpath
    if (bittes[0].split('/')[2]) rightpath = bittes[0].split('/')[2]
    let singleServer
    if (rightpath && config.servers.find(function(s){return s.HR === rightpath})) singleServer = rightpath
    bittes.shift()
    let params = bittes.join('?').trim().split('&').filter(String)
    let args = {}
    for (let i in params){
        let tmp = params[i].split('=')
        if (!tmp[1]) { tmp[1] = true }
        // handle sort
        // see https://lucene.apache.org/solr/guide/6_6/common-query-parameters.html#CommonQueryParameters-ThesortParameter
        if (tmp[0] === 'sort') {
          // split fields and then order
        }
        // build 1 level nested struct
        // see https://lucene.apache.org/solr/guide/6_6/highlighting.html
        if (tmp[0] === 'hl' && tmp[1] == 'on') {if (!args.hl) args.hl = {}}
        if (tmp[0] === 'q.op') tmp[0] = 'q_op'
        let nested = tmp[0].split('.')
        if (nested[1]) {
          if (!args[nested[0]]) args[nested[0]] = {}
          args[nested[0]][nested[1]]= tmp[1]
        }
        else {
          if (args[tmp[0]] === undefined) args[tmp[0]] = tmp[1]
        }
    }

    const { ip, username } = getIpUser(req)
    logNotice({ip,username,access:{route,urlPath,args}})
    switch (route) {
      // ----------------------------------------------------------------
      case 'GET/search':
      case 'GET/select':
      case 'GET/solr':
        if (username === config.uploadUser) break
        if (!args.q || typeof(args.q) != 'string')  {
          logError({ip,username,route,'msg':'no q in args'})
          res.end()
          break
        }
        if (args.q.indexOf('%') === -1) args.q = querystring.escape(args.q).trim()
        //TODO check max
        if (!args.rows) args.rows = 1
        args.rows = Math.min(args.rows,Math.floor(MAXRESULTS/config.servers.length))
        args.rows = Math.max(1,Math.ceil(args.rows/config.servers.length))
        if (!args.start) args.start = 0
        if (args.start > 0) args.start = Math.max(1,Math.ceil(args.start/config.servers.length))
        if (!args.fl) args.fl = 'id,score'
        else args.fl = 'id,score,'+args.fl
        if (args.hl) {
          args.hl.encoder = 'html'
          if (!args.hl.snippets) args.hl.snippets = 8
          if (!args.hl.fragsize) args.hl.fragsize = 64
          if (!args.hl.fl) args.hl.fl = 'content'
        }
        const gets = createGets(args,config.servers,singleServer)
        Promise.all(gets).then(function(results){
          let resEnd = {numFound:0,'start':args.start,found:[],docs:[]}
          for (let i in results){
            if (!results[i].server) throw new Error('no server')
            if (results[i].error) {
                let msg = results[i].error.message
                logWarning({route,msg,'server':results[i].server})
            } else {
                if (results[i].result) {
                  if (typeof(results[i].result) === 'object') {
                    logNotice({username,ip,'server':results[i].server.HR,'numFound':results[i].result.numFound,'docs':results[i].result.docs.length,args})
                    resEnd.numFound += results[i].result.numFound
                    resEnd.found.push({'server':results[i].server.HR,'numFound':results[i].result.numFound,'docs':results[i].result.docs.length})
                    while (results[i].result.docs.length > 0) {
                      let doc = results[i].result.docs.pop()
                      doc['_server_'] = results[i].server.HR
                      if (results[i].highlighting) {
                        //TODO if args.hl.fl == array
                        /*
                        if (results[i].highlighting[doc['id']] && results[i].highlighting[doc['id']][args.hl.fl]) {
                          doc['_highlighting_'] = results[i].highlighting[doc['id']][args.hl.fl]
                          delete(results[i].highlighting[doc['id']])
                        }
                        */
                        if (results[i].highlighting[doc['id']] ) {
                          doc['_highlighting_'] = ''
                          for (let hk in results[i].highlighting[doc['id']]) {
                            doc['_highlighting_'] += hk+' :: '+results[i].highlighting[doc['id']][hk]
                          }
                          delete(results[i].highlighting[doc['id']])
                        }
                      }
                      resEnd.docs.push(doc)
                      resEnd.docs.sort(function(a, b) { return b.score - a.score })
                    }
                  }
                }
            }
          }

          res.end(JSON.stringify({'response':resEnd}))
        })
        .catch(function(err) {
          if (process.stdout.isTTY) console.dir(err)
          let critical = 'This Should Never Happen :: ' + err.message
          logError({'route':'GET/search',critical})
          res.end('')
        })
        break;
      case 'GET/fields': // --------------------------------------------------
        if (username === config.uploadUser) break
        let getFields = []
        for (let i in config.servers){
          let server = config.servers[i]
          getFields.push(new Promise((resolve, reject) => {
              let query = ''
              switch (server.type) {
                case 'solr':
                  // https://stackoverflow.com/questions/3211139/solr-retrieve-field-names-from-a-solr-index
                  query += '/solr/'+server.collection+'/select?q=*:*&wt=csv&rows=0&facet'
                  httpGet(server.proto, server.host, server.port, query)
                  .then(function(result){
                      let fields = result.split(',')
                      resolve({server,fields})
                  })
                  .catch(function(error){
                    logWarning({error,query,server})
                    resolve({server})
                  })
                  break
                case 'elastic':
                case 'elasticsearch':
                    // https://www.elastic.co/guide/en/elasticsearch/reference/current/indices-get-mapping.html
                    query += '/'+server.collection+'/_mapping/'
                    httpGet(server.proto, server.host, server.port, query)
                    .then(function(result){
                        fields = []
                        try {
                          let tmp = JSON.parse(result)
                          if (tmp.error) logWarning({'error':tmp.error,query,server})
                          else {
                            if (tmp[server.collection].mappings.document.properties) for (let field in tmp[server.collection].mappings.document.properties) fields.push(field)
                            else logError({'error':'no mappings.document.properties',query,server})
                          }
                        } catch (e) {
                          let error = e.message
                          logError({error,query,server})
                        }
                        resolve({server,fields})
                    })
                    .catch(function(error){
                      logWarning({error,query,server})
                      resolve({server})
                    })
                  break
                default:
                  logError({'msg':'not supported ' + server.type,server})
                  resolve({server})
              }
            })
          )
        }
        Promise.all(getFields).then(function(results){
          let fields = ['id','score','_server_','_highlighting_']
          for (let i in results){
            if (results[i].fields) {
              while (results[i].fields.length > 0) {
                let field = results[i].fields.pop()
                if (field !== 'content' && field.indexOf('column_') === -1 && field.indexOf('_error_') === -1 && field.indexOf('_txt_') === -1 && field.endsWith('_b') === false) {
                  if (fields.indexOf(field) === -1 ) fields.push(field)
                }
              }
            }
          }
          res.end(fields.sort().join(','))
        })
        .catch(function(err) {
          if (process.stdout.isTTY) console.dir(err)
          let critical = 'This Should Never Happen :: ' + err.message
          logError({'route':'GET/fields',critical,err})
          res.end('')
        })
        break;
      case 'POST/errors':
      if (username === config.uploadUser) break
        let errors = [];
        req.on('data', (chunk) => {
          errors.push(chunk);
        }).on('end', () => {
          errors = Buffer.concat(errors).toString();
          try {
            errors = JSON.parse(errors)
            for (let i in errors) logWarning({ip,username,'browser':errors[i]})
          } catch (e) {
            logWarning({ip,username,'browser':errors})
          }
        })
        res.end('thanks for errors')
        break;
      case 'GET/files':
      if (username === config.uploadUser) break
        if (args.server && args.file) {
          let i = config.servers.findIndex(function(s){return s.HR === args.server})
          if (i > -1) {
            let server = config.servers[i]
            let f = decodeURIComponent(args.file).replace(config.etlMapping,'') // same as in ETL config['mappings'] = { "/": "file:///" }

            try {
              let freq = http.get('http://'+server.host+':'+config.filesPort+'/'+f, (fres) => {
                fres.on('error', (error) => {
                  res.end()
                  logWarning({'fileserver':args.server,error})
                })
                const { statusCode, statusMessage, headers } = fres
                if (statusCode !== 200) {
                  logWarning({ip,username,'not200':{'code':statusCode,'message':statusMessage}})
                  res.end()
                } else {
                  res.writeHead(200, { 'Content-Type': headers['content-type'] })
                  fres.on('data', (chunk) => { res.write(chunk)})
                  fres.on('end', () => { res.end() })
                }
              })
              freq.on('error', (error) => {
                logWarning({'fileserver':args.server,error})
                res.end()
              })
            } catch (error) {
              logWarning({'fileserver':args.server,error})
              res.end()
            }
          } else {
            logWarning({ip,username,'notServer':args})
            res.end()
          }
        }
        break
      case 'PUT/files':
      case 'POST/files':
        if (req.headers['content-type'] && req.headers['content-type'].indexOf('multipart/form-data;')>-1 ) {
          try {
            let result = {}
            let busboy = new Busboy({ preservePath: true, headers: req.headers })
            let fields = {}
            busboy.on('error', function(error){
              result.error = error
              let msg = error.message
              logWarning({ip,username,route,msg})
            })
            busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) {
              fields['upload_'+fieldname] = val
            })
            busboy.on('file', async function(fieldname, file, filename, encoding, mimetype) {
              let chuncks = []
              let compressor
              try {
                // TODO --block-size=$((16*1024*1024))
                compressor = lzma.createCompressor({preset: 9})
              } catch (error) {
                logCritical({lzma:error.message})
                try {
                  compressor = lzma.createCompressor({preset: 5})
                } catch (error) {
                  logCritical({lzma:error.message})
                  compressor = new require('stream').PassThrough();
                }
              }
              const uid = guid()
              const savePath = path.join(config.uploadDirectory)
              const sDir = await ensureDirectory(savePath)
              if (sDir) {
                const hash = crypto.createHash('md5');
                const saveTo = path.join(savePath, uid+'.tmp');
                file.pipe(compressor).pipe(fs.createWriteStream(saveTo));
                file.on('data', function(data) {
                  chuncks.push(data.length)
                  hash.update(data)
                });
                file.on('end', async function() {

                  const md5 = hash.digest('hex')
                  fields.osse_prepack_md5 = md5
                  fields.osse_from_ip = ip
                  if (username) fields.osse_uploader = username
                  fields.osse_hostname = os.hostname()
                  //let q = `${config.md5Fieldname}:${md5}`
                  // TODO check fields *md5*
                  let q = `${md5}`
                  const gets = createGets({q:q,rows:10,start:0,fl:'id'},config.servers)
                  let found = false
                  const results = await Promise.all(gets)
                  for (const result of results){
                    if (result.result && result.result.numFound && result.result.numFound > 0){
                      found = true
                      if (result.result.docs) {
                         for (const doc of result.result.docs){
                           if (doc.id) {
                             logNotice({ip,username,uploadExist:{md5,filename,id:doc.id,server:result.server.HR,saveTo}})
                           }
                         }
                      }
                    }
                  }
                  if (found) {
                    fs.unlinkSync(saveTo)
                    result.error = 'file exist'
                    res.end(JSON.stringify(result))
                    //res.write('file exists: '+filename)
                  } else {
                    //if (fields.upload_lastModified)
                    fields.upload_lastModified = date2JSON(fields.upload_lastModified)
                    //if (!fields.upload_lastModified) fields.upload_lastModified = 0
                    let tmp = []
                    if (fields.upload_tags && fields.upload_tags.length > 3) tmp = fields.upload_tags.split(',')
                    tmp.push('uploaded')
                    tmp.sort(function(a, b) {return a.length - b.length;});
                    let kala = `${filename}|${fields.upload_lastModified}|${username}|${tmp.join(',')}`
                    let packed = await compress2Base64Url(kala)
                    if (packed.length > 254) {
                      // drop longest tags
                      while (tmp.length > 0) {
                        const tag = tmp.pop()
                        logNotice({ip,username,dropTag:tag,filename})
                        kala = `${filename}|${fields.upload_lastModified}|${username}|${tmp.join(',')}`
                        packed = await compress2Base64Url(kala)
                        if (packed.length < 254) break
                      }
                    }
                    if (packed.length > 254) {
                      // drop username
                      logNotice({ip,username,dropUser:username,filename})
                      kala = `$${filename}|${fields.upload_lastModified}`
                      packed = await compress2Base64Url(kala)
                    }
                    if (packed.length > 254) {
                      // drop time
                      logNotice({ip,username,dropTime:fields.upload_lastModified,filename})
                      kala = `$${filename}`
                      packed = await compress2Base64Url(kala)
                    }
                    if (packed.length > 254) {
                      // give up
                      logWarning({ip,username,uploadFileNameToLong:{filename}})
                      fs.unlinkSync(saveTo)
                      result.error = 'file name to long'
                      res.end(JSON.stringify(result))
                    } else {
                      res.end()
                      const kala2 = await decompress2Base64Url(packed)
                      if (kala2 !== kala){
                          logError({critical:{compress2Base64Url:'wrong chop',packed,kala}})
                      }
                      const newPath = path.join(savePath,packed)
                      try {
                        fs.renameSync(saveTo, newPath)
                      } catch (error) {
                        logError({renameFailed:{saveTo, newPath}})

                      }
                      logNotice({ip,username,uploadedFile:{md5,filename,spool:newPath,kala,fields}})
                      httpPost(config.uploadFileServerProto,config.uploadFileServer, config.filesPort, '/',newPath,fields)
                      .then(function(result){
                          logNotice({fileserverOK:{server:config.uploadFileServer,file:newPath,fields}})
                          try {
                            // TODO make all unlinkSync wait
                            fs.unlinkSync(newPath)
                          } catch (error) {
                            logError({error})
                          }
                      })
                      .catch(function(error){
                        //TODO handle leftovers ...
                        logWarning({fileservererror:{server:config.uploadFileServer,file:newPath,error:error.message}})
                      })
                    }
                  }
                });
              }
            })
            busboy.on('finish', async function() {
              //res.end(JSON.stringify(result))
            });
            req.pipe(busboy);
          } catch (error){
            let msg = error.message
            logWarning({ip,username,route,msg})
            result.error = error.message
            res.end(JSON.stringify(result))

          }
        } else {
          logWarning({ip,username,route,'msg':'not a multipart/form-data'})

        }
        break;
      case 'GET/subscriptions':
        if (username === config.uploadUser) break
        let subscriptions  = await readJSON(path.join(config.subscriptionsDirectory,username,'subscriptions.json'))
        if (subscriptions == false || !subscriptions.fields ) res.end('')
        else res.end(JSON.stringify({'fields':subscriptions.fields}))
        break;
      case 'POST/subscriptions':
        if (username === config.uploadUser) break
        if (req.headers['content-type'] && req.headers['content-type'].indexOf('multipart/form-data;')>-1) {
          let subsFields = {}
          try {
            let subsBusBoy = new Busboy({ preservePath: true, headers: req.headers })
            subsBusBoy.on('error', function(error){
              let msg = error.message
              logWarning({ip,username,route,msg})
            });
            subsBusBoy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) {
              subsFields[fieldname] = val
            })
            subsBusBoy.on('finish', async function() {
              let uploadtime = nowAsJSON()
              let emails = users[username]['ipa']['mail']
              let subsFile = false
              let subscriptionsDirectory = await ensureDirectory(path.join(config.subscriptionsDirectory,username))
              if (subscriptionsDirectory) {
                subsFile = await writeFile(path.join(config.subscriptionsDirectory,username,'subscriptions.json'),JSON.stringify({uploadtime,username,emails,'fields':subsFields}))
              }
              if (!subsFile) {
                res.end('try again')
                let msg = 'writing subscriptions failed'
                logError({ip,username,msg})
              } else {
                res.end('thanks for subscriptions')
              }
            })
            req.pipe(subsBusBoy);
          } catch (error){
            res.end('try again')
            let msg = error.message
            logWarning({ip,username,route,msg})

          }
        } else logWarning({ip,username,route,'msg':'not a multipart/form-data'})
        break
      case 'GET/static':
        if (username === config.uploadUser) break
        let staticFilename = path.join(config.staticDirectory,urlPath)
        let staticFile = await readFile(staticFilename)
        if (staticFile === false){
          logError({ip,username,'msg':'file does not exist',staticFilename,urlPath})
          res.end()
        } else {
          const mimeType = {
                          '.ico': 'image/x-icon',
                          '.html': 'text/html',
                          '.js': 'text/javascript',
                          '.json': 'application/json',
                          '.css': 'text/css',
                          '.png': 'image/png'}
          const ext = path.parse(staticFilename).ext
          res.setHeader('Content-type', mimeType[ext] || 'text/plain' )
          res.end(staticFile)
        }
        break
      case 'GET/favicon.ico':
        if (username === config.uploadUser) break
        let icoFile = await readFile(path.join(config.staticDirectory,'static/favicon.ico'))
        if (icoFile === false) {
          logError({'msg':'missing favicon.ico'})
          res.end()
        } else {
          res.setHeader('Content-type','image/x-icon')
          res.end(icoFile)
        }
        break
      case 'GET/index.html':
        if (username === config.uploadUser) break
        let indexFile = await readFile(path.join(config.staticDirectory,'index.html'))
        if (indexFile === false) {
          logError({'msg':'missing index.html'})
          res.end()
        } else {
          res.setHeader('Content-type','text/html')
          res.end(indexFile)
        }
        break
      case 'GET/':
          if (username === config.uploadUser) break
          res.writeHead(301, {'Location' : '/index.html'});
          res.end();
          break
      default:
        let msg = 'missing route'
        logWarning({ip,username,msg,route})
        res.statusCode = 418
        res.end()
    }
  })

  process.on('SIGTERM', async function () {
    logNotice({'msg':'got SIGTERM'})
    let saved = await writeFile(config.usersFile,JSON.stringify(users))
    logNotice({'msg':'saved users', saved})
    osse.close(function () {
      logNotice({'msg':'close server done'})
      process.exit(0);
    });
  })

  osse.listen(config.portListen, config.ipBind);

}

process.on('uncaughtException', (error) => {
  logError({'uncaughtException':`${error}`})
  if (process.stdout.isTTY) console.log(error)
});

main()
.then(console.log)
.catch(console.error)
