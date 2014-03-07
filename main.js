var path = require('path');
var swig = require('swig');
var url = require('url');
var fs = require('fs');
var os = require('os');
var server = null;
var db = null;
var ctype = {
    "html" : "text/html",
    "css" : "text/css",
    "js" : "application/javascript"
};
var template = {};
var waiters = {};
var clusterDefault = {};
var params = {
    boothost : [os.hostname(),8008].join(":")
};

/**
 * TODO
 * REMOVE injection since it's passed in localStorage now
 * check image date/size/md5sum ? each time and stop/download/unzip ?
 * add simple config (db) mem caching layer
 * fix linux vs mac osx rabbit cmd (auto switch in boot?)
 */

var http = {
    handle : function(req, res) {
        console.log("--> "+req.url);
        if (!(req.method == 'GET' || req.method == 'POST')) {
            return http.fail(res);
        }
        var purl = url.parse(req.url, true);

        var func = complete[purl.pathname];
        if (func) return func(req, res, purl);

        for (var key in prefix) {
            if (purl.pathname.indexOf(key) == 0) {
                return prefix[key](req, res, purl);
            }
        }

        http.fail(res, "no valid target", 404);
    },

    sendFile : function(res, filePath) {
        try {
            var suffix = filePath.substring(filePath.lastIndexOf('.')+1);
            var contentType = ctype[suffix] || "application/octet-stream";
            var contentLength = fs.statSync(filePath).size;
            res.writeHead(200, {
                'Content-Type' : contentType,
                'Content-Length' : contentLength
            });
            fs.createReadStream(filePath).pipe(res);
        } catch (error) {
            console.log(["error",error]);
            http.fail(res, error, 500);
        }
    },

    template : function(res, templateName, values, ctype) {
        swig.renderFile(templateName, values, function(err, output) {
            if (err) return http.fail(res, err, err.errno == 34 ? 404 : 500);
            return http.ok(res, output, ctype);
        });
    },

    bounce : function(res, url) {
        res.writeHead(302, {'Location': url});
        res.end();
    },

    ok : function(res, msg, ctype) {
        var out = (typeof msg == 'string' ? msg : JSON.stringify(msg))+"\n";
        res.writeHead(200, {'Content-Type': ctype || 'text/plain', 'Content-Length' : out.length});
        res.end(out);
    },

    fail : function(res, msg, code) {
        res.writeHead(code | 404, {'Content-Type': 'text/plain'});
        res.end((typeof msg == "string" ? msg : "unsupported request "+msg) + "\n");
    }
};


var config = {
    key : function(arr) {
        return ["config",arr.join('-')].join('/');
    },

    get : function(arr, options, callback) {
        fs.readFile(config.key(arr), options, callback);
    },

    put : function(arr, val, options, callback) {
        fs.writeFile(config.key(arr), val, options, callback);
    },

    delete : function(arr, callback) {
        fs.unlink(config.key(arr), function(err) {
            if (callback) callback(err);
        });
    },

    getJS : function(arr, callback) {
        config.get(arr, null, function(err, data) {
            if (err) return callback(err);
            callback(null, eval(["(",data,")"].join("")));
        });
    },

    putJS : function(arr, val, callback) {
        config.put(arr, JSON.stringify(val,null,"  "), null, callback);
    }
};

var complete = {
    "/help" : function(req, res, url) {
        return http.ok(res, [
            "/api/list_clusters", "/api/create_cluster", "/api/get_cluster", "/api/delete_cluster", "/api/boot_node"
        ]);
    },
    "/hint" : function(req, res, url) {
        url.pathname = "/render/hint";
        return prefix["/render/"](req, res, url);
    },
    "/boot" : function(req, res, url) {
        url.pathname = "/render" + url.pathname;
        return prefix["/render/"](req, res, url);
    },
    "/" : function(req, res, url) {
        return http.bounce(res, "/me/index.html");
    },
    "/me" : function(req, res, url) {
        return http.bounce(res, "/me/index.html");
    },
    "/me/" : function(req, res, url) {
        return http.bounce(res, "/me/index.html");
    }
};

var prefix = {
    "/api/" : function(req, res, url) {
        var funcName = url.pathname.substring(5);
        var func = api[funcName];
        if (typeof func == 'undefined') {
            return http.fail(res, "invalid api endpoint '"+funcName+"'");
        }
        func(url.query, req.socket.remoteAddress, function(err, obj) {
            if (err) {
                http.fail(res, err);
            } else {
                http.ok(res, obj);
            }
        });
    },
    "/image/" : function(req, res, url) {
        var path = ["config","image",url.pathname.substring(7)];
        var filePath = path.join('/');
        if (url.query.ifnotsize) {
            var size = fs.statSync(filePath).size;
            if (size == parseInt(url.query.ifnotsize)) return http.fail(res, 'same size', 404);
        }
        return http.sendFile(res, filePath);
    },
    "/me/" : function(req, res, url) {
        url.pathname = "/render"+url.pathname;
        return prefix["/render/"](req, res, url);
    },
    "/render/" : function(req, res, url) {
        var filePath = url.pathname;
        var suffix = filePath.substring(filePath.lastIndexOf('.')+1);
        var contentType = ctype[suffix];
        var funcName = filePath.substring(8);
        var func = render[funcName];
        var call = function(res, q, cluster, host) {
            if (cluster.authKey) cluster.config.defaults.authkey = cluster.authKey;
            if (func) {
                func(res, q, cluster, host);
            } else {
                http.template(res, q.funcName, cluster.config, contentType);
            }
        };
        var q = url.query;
        q.hostname = q.hostname || req.socket.remoteAddress;
        q.funcName = funcName;
        if (q.cluster && q.hostname) {
            return config.getJS(['cluster', q.cluster], function(err, cluster) {
                if (err) return http.fail(res, 'invalid cluster '+ q.cluster);
                setDefaults(clusterDefault, cluster);
                if (cluster.shortenHost) {
                    q.hostname = shortenHost(q.hostname);
                }
                var host = cluster.node[q.hostname] || cluster.node.defaults;
                call(res, q, cluster, host);
            });
        }
        call(res, q, {}, {});
    }
};

var renderJS = function(res, query, cluster, host) {
    http.template(res, query.funcName, {
        boothost: params.boothost,
        cluster: query.cluster
    });
};

var renderHTML = function(res, query, cluster, host) {
    http.template(res, query.funcName, {
        boothost: params.boothost,
        cluster: query.cluster
    }, "text/html");
};

var render = {
    "hcl" : function(res, query, cluster, host) {
        http.template(res, query.funcName, {
            cluster: query.cluster,
            hostname: query.hostname,
            boothost: params.boothost
        });
    },

    "boot" : function(res, query, cluster, host) {
        if (cluster.isLocal) query.hostname = 'localhost';
        http.template(res, query.funcName, {
            cluster: query.cluster,
            hostname: query.sethost,
            boothost: params.boothost
        });
    },

    "boot-two" : function(res, query, cluster, host) {
        if (!host) return http.fail(res, 'invalid host '+ query.hostname);
        if (!host.process) return http.fail(res, 'host missing process list');
        http.template(res, query.funcName, {
            hostname: query.hostname,
            process: host.process.join(' '),
            images: (host.image || cluster.node.defaults.image).join(' '),
            imageroot: cluster.imageRoot || ['http://',params.boothost,'/image/default'].join('')
        });
    },

    "hint" : function(res, query, cluster, host) {
        http.template(res, query.funcName, {
            boothost: params.boothost,
            cluster:query.cluster
        });
    },

    "me/me.js" : renderJS,
    "me/spawn/spawn.js" : renderJS,
    "me/query/query.js" : renderJS,
    "me/spawn/spawn.html" : renderHTML,
    "me/query/query.html" : renderHTML
};

var shortenHost = function(hostname) {
    var newhost = hostname.split(".")[0];
    return (Number.isNaN(parseInt(newhost))) ? newhost : hostname;
};

var oGet = function(obj, find, dv) {
    var o = obj;
    if (!Array.isArray(find)) {
        find = find.split(".");
    }
    for (var i=0; i<find.length; i++) {
        o = o[find[i]];
        if (typeof o == 'undefined') {
            break;
        }
    }
    return (typeof o == 'undefined') ? dv : o;
};

var oMerge = function(o) {
    var m = {};
    for (var i=0; i<o.length; i++) {
        for (var k in o[i]) {
            m[k] = o[i][k];
        }
    }
    return m;
};

var firstKey = function(o) {
    for (var key in o) return key;
};

var getKeys = function(o) {
    var keys = [];
    for (var key in o) keys.push(key);
    return keys;
};

var countKeys = function(o) {
    return getKeys(o).length;
};

var setDefaults = function(oS, oT) {
    for (var key in oS) {
        if (typeof oT[key] == 'undefined') oT[key] = oS[key];
    }
};

var api = {
    wait_nodes : function(query, remote, callback) {
        if (!query.cluster) return callback("missing cluster");
        if (!query.key) return callback("missing key");
        config.getJS(['cluster',query.cluster], function(err, cluster) {
            if (err) return callback(err);
            if (cluster.isLocal) return callback(null, 'localhost');
            var target = cluster.require[query.key];
            if (typeof target == 'undefined') return callback("invalid target key '"+query.key+"'");
            if (!cluster.proc || !cluster.proc[query.key] || countKeys(cluster.proc[query.key]) < target) {
                var wait_key = [query.cluster,query.key].join('_');
                if (!waiters[wait_key]) {
                    waiters[wait_key] = [];
                }
                waiters[wait_key].push({target:target,callback:callback});
            } else {
                callback(null, getKeys(cluster.proc[query.key]).join(" "));
            }
        });
    },

    register_node : function(query, remote, callback) {
        if (!query.hostname) return callback("missing hostname");
        if (!query.cluster) return callback("missing cluster");
        if (!query.key) return callback("missing key");
        var hostname = query.hostname;
        var dbkey = ['cluster',query.cluster];
        config.getJS(dbkey, function(err, cluster) {
            if (err) return callback(err);
            if (cluster.isLocal) return callback(null, {node:{ip:remote},localstack:true});
            setDefaults(clusterDefault, cluster);
            var target = cluster.require[query.key];
            if (typeof target == 'undefined'){
                cluster.require[query.key] = 0;
            }
            var wait_key = [query.cluster,query.key].join('_');
            if (!cluster.proc) {
                cluster.proc = {};
            }
            if (!cluster.proc[query.key]) {
                cluster.proc[query.key] = {};
            }
            if (cluster.shortenHost) {
                hostname = shortenHost(hostname);
            }
            if (!cluster.proc[query.key][hostname]) {
                var waiting = waiters[wait_key];
                if (waiting) {
                    var key_hosts = cluster.proc[query.key];
                    var keys = [];
                    for (var key in key_hosts) {
                        keys.push(key);
                    }
                    var notified = 0;
                    for (var i=0; i<waiting.length; i++) {
                        if (!waiting[i]) {
                            notified++;
                            continue;
                        }
                        if (waiting[i].target <= keys.length) {
                            waiting[i].callback(null, keys.join(" "));
                            waiting[i] = null;
                            notified++;
                        }
                    }
                    if (notified == waiting.length) {
                        delete waiters[wait_key];
                    }
                }
            }
            var conf = cluster.proc[query.key][hostname] = {ip:remote,config:query.config,updated:new Date().getTime()};
            config.putJS(dbkey, cluster, function(err) {
                if (err) throw err;
            });
            callback(null,{node:conf});
        });
    },

    get_account : function(query, remote, callback) {
        var key = ['account',query.id];
        config.getJS(key, function(err, account) {
            if (err) {
                callback(err);
            } else {
                callback(null, account);
            }
        });
    },

    create_account : function(query, remote, callback) {
        if (remote != "127.0.0.1") return callback("not authorized");
        var id = require('node-uuid').v1().replace(/-/g,'');
        var key = ['account',id];
        var init = {permits:query.permits || 5,clusters:[]};
        config.putJS(key, init, function(err, val) {
            if (err) {
                callback(err);
            } else {
                callback(null,{account:id,config:init});
            }
        });
    },

    delete_account : function(query, remote, callback) {
        if (remote != "127.0.0.1") return callback("not authorized");
        if (!query.id) return callback("missing account id");
        var id = query.id;
        var key = ['account',id];
        config.getJS(key, function(err, account) {
            if (err) {
                callback("invalid account id");
            } else {
                for (var i=0; i<account.clusters.length; i++) {
                    config.delete(['cluster',account.clusters[i]]);
                }
                config.delete(key, function(err) {
                    if (err) return callback("unable to delete account");
                    callback(null,{account:id,deleted:true});
                });
            }
        });
    },

    create_cluster : function(query, remote, callback) {
        var clusterID = require('node-uuid').v1().replace(/-/g,'');
        var clusterKey = ['cluster',clusterID];
        var accountID = query.account;
        if (!accountID) {
            return callback("missing account id");
        }
        var accountKey = ['account',accountID];
        config.getJS(accountKey, function(err, account) {
            if (err || !account) return callback("invalid account id");
            if (account.permits <= 0) return callback("insufficient account permits");
            config.getJS(clusterKey, function(err, val) {
                if (err) {
                    var init = clusterDefault;//{require:{},proc:{},node:{defaults:{}},config:{defaults:{}}};
                    config.putJS(clusterKey, init, function(err) {
                        if (err) {
                            callback("db put fail");
                        } else {
                            account.permits--;
                            account.clusters.push(clusterID);
                            config.putJS(accountKey, account, function(err) {
                                callback(err, {cluster:clusterID,config:init});
                            });
                        }
                    });
                } else {
                    callback("db key exists");
                }
            });
        });
    },

    delete_cluster : function(query, remote, callback) {
        if (!query.account) return callback("missing account id");
        if (!query.cluster) return callback("missing cluster id");
        var accountKey = ['account',query.account];
        var clusterKey = ['cluster',query.cluster];
        config.getJS(accountKey, function(err, account) {
            if (err || !account) return callback("invalid account id");
            config.getJS(clusterKey, function(err, cluster) {
                if (err || !cluster) return callback("invalid cluster id");
                config.delete(clusterKey, function(err) {
                    if (err) return callback("failed to delete cluster");
                    account.permits++;
                    for (var i=0; i<account.clusters.length; i++) {
                        if (account.clusters[i] == query.cluster) {
                            account.clusters.splice(i,1);
                            break;
                        }
                    }
                    config.putJS(accountKey, account, function(err) {
                        if (err) return callback("failed to update account");
                        callback(null, {cluster:query.cluster,deleted:true});
                    });
                });
            });
        });
    },

    update_cluster : function(query, remote, callback) {
        if (!query.account) return callback("missing account id");
        if (!query.cluster) return callback("missing cluster id");
        if (!query.data) return callback("missing cluster data");
        var accountKey = ['account',query.account];
        var clusterKey = ['cluster',query.cluster];
        config.getJS(accountKey, function(err, account) {
            if (err || !account) return callback("invalid account id");
            config.getJS(clusterKey, function(err, cluster) {
                if (err || !cluster) return callback("invalid cluster id");
                var newCluster = JSON.parse(query.data);
                // preserve running cluster process state data
                newCluster.proc = cluster.proc;
                config.putJS(clusterKey, newCluster, function(err) {
                    if (err) return callback("failed to update cluster");
                    callback(null, {cluster:query.cluster,updated:true});
                });
            });
        });
    },

    get_cluster : function(query, remote, callback) {
        var key = ['cluster',query.id];
        config.getJS(key, function(err, val) {
            if (err) {
                callback(err);
            } else {
                callback(null,val);
            }
        });
    },

    reload_defaults : function(query, remote, callback) {
        config.getJS(['cluster', "defaults"], function(err, cluster) {
            if (!err && cluster) {
                setDefaults(cluster, clusterDefault);
                return callback(null, "{success:true}");
            }
            callback(err, "missing defaults");
        });
    }
};

var exports = {
    config : function(key,val) {
        params[key] = val;
    },
    init : function() {
        if (server != null) {
            throw "server already initialized"
        }
        swig.setDefaults({ loader: swig.loaders.fs('config/template' ), cache: false });
        server = require('http').createServer(function (req, res) {
            http.handle(req, res);
        }).listen(parseInt(params.boothost.split(':')[1]));
        config.getJS(['cluster', "defaults"], function(err, cluster) {
            if (!err && cluster) {
                setDefaults(cluster, clusterDefault);
            }
        });
        console.log("started cluster boot service as "+params.boothost);
    }
};

module.exports = exports;
