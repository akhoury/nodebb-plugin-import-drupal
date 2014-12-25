
var async = require('async');
var mysql = require('mysql');
var _ = require('underscore');
var noop = function(){};
var logPrefix = '[nodebb-plugin-import-drupal]';

(function(Exporter) {

    Exporter.setup = function(config, callback) {
        Exporter.log('setup');

        // mysql db only config
        // extract them from the configs passed by the nodebb-plugin-import adapter
        var _config = {
            host: config.dbhost || config.host || 'localhost',
            user: config.dbuser || config.user || 'user',
            password: config.dbpass || config.pass || config.password || undefined,
            port: config.dbport || config.port || 3306,
            database: config.dbname || config.name || config.database || 'drupal'
        };

        Exporter.config(_config);
        Exporter.config('prefix', config.prefix || config.tablePrefix || '');

        config.custom = config.custom || {};
        if (typeof config.custom === 'string') {
            try {
                config.custom = JSON.parse(config.custom)
            } catch (e) {}
        }

        Exporter.config('custom', config.custom || {
            messagesPlugin: ''
        });

        if (!config.custom.messagesPlugin) {
            Exporter.warn('\nNo chat plugin was entered in the custom config. Falling back to Core.'
            + '\nWere you using a chat plugin for chat? if so, enter it in the custom config in the "pre import settings" as a valid JSON value. '
            + '\ni.e. {"messagesPlugin": "arrowchat"} or {"messagesPlugin": "cometchat"}'
            + '\nCurrently the supported plugins are: ' + Object.keys(supportedPlugins).join(', ') + '\n');
        }

        Exporter.connection = mysql.createConnection(_config);
        Exporter.connection.connect();

        callback(null, Exporter.config());
    };

    Exporter.query = function(query, callback) {
        if (!Exporter.connection) {
            var err = {error: 'MySQL connection is not setup. Run setup(config) first'};
            Exporter.error(err.error);
            return callback(err);
        }
        // console.log('\n\n====QUERY====\n\n' + query + '\n');
        Exporter.connection.query(query, function(err, rows) {
            //if (rows) {
            //    console.log('returned: ' + rows.length + ' results');
            //}
            callback(err, rows)
        });
    };
    var getGroups = function(config, callback) {
        if (_.isFunction(config)) {
            callback = config;
            config = {};
        }
        callback = !_.isFunction(callback) ? noop : callback;
        if (!Exporter.connection) {
            Exporter.setup(config);
        }
        var prefix = Exporter.config('prefix');
        var query = 'SELECT '
            + prefix + 'usergroup.usergroupid as _gid, '
            + prefix + 'usergroup.title as _title, ' // not sure, just making an assumption
            + prefix + 'usergroup.pmpermissions as _pmpermissions, ' // not sure, just making an assumption
            + prefix + 'usergroup.adminpermissions as _adminpermissions ' // not sure, just making an assumption
            + ' from ' + prefix + 'usergroup ';
        Exporter.query(query,
            function(err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }
                var map = {};

                //figure out the admin group
                var max = 0, admingid;
                rows.forEach(function(row) {
                    var adminpermission = parseInt(row._adminpermissions, 10);
                    if (adminpermission) {
                        if (adminpermission > max) {
                            max = adminpermission;
                            admingid = row._gid;
                        }
                    }
                });

                rows.forEach(function(row) {
                    if (! parseInt(row._pmpermissions, 10)) {
                        row._banned = 1;
                        row._level = 'member';
                    } else if (parseInt(row._adminpermissions, 10)) {
                        row._level = row._gid === admingid ? 'administrator' : 'moderator';
                        row._banned = 0;
                    } else {
                        row._level = 'member';
                        row._banned = 0;
                    }
                    map[row._gid] = row;
                });
                // keep a copy of the users in memory here
                Exporter._groups = map;
                callback(null, map);
            });
    };

    Exporter.getUsers = function(callback) {
        return Exporter.getPaginatedUsers(0, -1, callback);
    };
    Exporter.getPaginatedUsers = function(start, limit, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var prefix = Exporter.config('prefix') || '';
        var startms = +new Date();

        var query = 'SELECT '
            + prefix + 'user.userid as _uid, '
            + prefix + 'user.email as _email, '
            + prefix + 'user.username as _username, '
            + prefix + 'sigparsed.signatureparsed as _signature, '
            + prefix + 'user.joindate as _joindate, '
            + prefix + 'customavatar.filename as _pictureFilename, '
            + prefix + 'customavatar.filedata as _pictureBlob, '
            + prefix + 'user.homepage as _website, '
            + prefix + 'user.reputation as _reputation, '
            + prefix + 'user.profilevisits as _profileviews, '
            + prefix + 'user.birthday as _birthday '
            + 'FROM ' + prefix + 'user '
            + 'LEFT JOIN ' + prefix + 'sigparsed ON ' + prefix + 'sigparsed.userid=' + prefix + 'user.userid '
            + 'LEFT JOIN ' + prefix + 'customavatar ON ' + prefix + 'customavatar.userid=' + prefix + 'user.userid '
            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');


        getGroups(function(err, groups) {
            Exporter.query(query,
                function(err, rows) {
                    if (err) {
                        Exporter.error(err);
                        return callback(err);
                    }

                    //normalize here
                    var map = {};
                    rows.forEach(function(row) {
                        // nbb forces signatures to be less than 150 chars
                        // keeping it HTML see https://github.com/akhoury/nodebb-plugin-import#markdown-note
                        row._signature = Exporter.truncateStr(row._signature || '', 150);

                        // from unix timestamp (s) to JS timestamp (ms)
                        row._joindate = ((row._joindate || 0) * 1000) || startms;

                        // lower case the email for consistency
                        row._email = (row._email || '').toLowerCase();
                        row._website = Exporter.validateUrl(row._website);

                        row._level = (groups[row._gid] || {})._level || '';
                        row._banned = (groups[row._gid] || {})._banned || 0;

                        map[row._uid] = row;
                    });

                    callback(null, map);
                });
        });
    };


    var getCometChatPaginatedMessages = function(start, limit, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var startms = +new Date();
        var prefix = Exporter.config('prefix') || '';
        var query = 'SELECT '
            + prefix + 'cometchat.id as _mid, '
            + prefix + 'cometchat.from as _fromuid, '
            + prefix + 'cometchat.to as _touid, '
            + prefix + 'cometchat.message as _content, '
            + prefix + 'cometchat.sent as _timestamp, '
            + prefix + 'cometchat.read as _read '
            + 'FROM ' + prefix + 'cometchat '
            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

        Exporter.query(query,
            function(err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }
                //normalize here
                var map = {};
                rows.forEach(function(row) {
                    row._timestamp = ((row._timestamp || 0) * 1000) || startms;
                    map[row._mid] = row;
                });

                callback(null, map);
            });
    };

    var getArrowChatPaginatedMessages = function(start, limit, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var startms = +new Date();
        var prefix = Exporter.config('prefix') || '';
        var query = 'SELECT '
            + prefix + 'arrowchat.id as _mid, '
            + prefix + 'arrowchat.from as _fromuid, '
            + prefix + 'arrowchat.to as _touid, '
            + prefix + 'arrowchat.message as _content, '
            + prefix + 'arrowchat.sent as _timestamp, '
            + prefix + 'arrowchat.read as _read '
            + 'FROM ' + prefix + 'arrowchat '
            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

        Exporter.query(query,
            function(err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }
                //normalize here
                var map = {};
                rows.forEach(function(row) {
                    row._timestamp = ((row._timestamp || 0) * 1000) || startms;
                    map[row._mid] = row;
                });

                callback(null, map);
            });
    };

    var supportedPlugins = {
        cometchat: getCometChatPaginatedMessages,
        arrowchat: getArrowChatPaginatedMessages
    };

    Exporter.getMessages = function(callback) {
        return Exporter.getPaginatedMessages(0, -1, callback);
    };
    Exporter.getPaginatedMessages = function(start, limit, callback) {
        var custom = Exporter.config('custom') || {};
        custom.messagesPlugin = (custom.messagesPlugin || '').toLowerCase();

        if (supportedPlugins[custom.messagesPlugin]) {
            return supportedPlugins[custom.messagesPlugin](start, limit, callback);
        }

        callback = !_.isFunction(callback) ? noop : callback;

        var startms = +new Date();
        var prefix = Exporter.config('prefix') || '';
        var query = 'SELECT '
            + prefix + 'pm.pmid as _mid, '
            + prefix + 'pmtext.fromuserid as _fromuid, '
            + prefix + 'pm.userid as _touid, '
            + prefix + 'pmtext.message as _content, '
            + prefix + 'pmtext.dateline as _timestamp '
            + 'FROM ' + prefix + 'pm '
            + 'LEFT JOIN ' + prefix + 'pmtext ON ' + prefix + 'pmtext.pmtextid=' + prefix + 'pm.pmtextid '
            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

        Exporter.query(query,
            function(err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }
                //normalize here
                var map = {};
                rows.forEach(function(row) {
                    row._timestamp = ((row._timestamp || 0) * 1000) || startms;
                    map[row._mid] = row;
                });

                callback(null, map);
            });
    };

    Exporter.getCategories = function(callback) {
        return Exporter.getPaginatedCategories(0, -1, callback);
    };
    Exporter.getPaginatedCategories = function(start, limit, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var prefix = Exporter.config('prefix');
        var startms = +new Date();

        var query = 'SELECT '
            + prefix + 'forum.forumid as _cid, '
            + prefix + 'forum.title as _name, '
            + prefix + 'forum.description as _description, '
            + prefix + 'forum.displayorder as _order '
            + 'FROM ' + prefix + 'forum ' // filter added later
            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

        Exporter.query(query,
            function(err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }

                //normalize here
                var map = {};
                rows.forEach(function(row) {
                    row._name = row._name || 'Untitled Category ';
                    row._description = row._description || 'No decsciption available';
                    row._timestamp = ((row._timestamp || 0) * 1000) || startms;
                    map[row._cid] = row;
                });

                callback(null, map);
            });
    };

    Exporter.getTopics = function(callback) {
        return Exporter.getPaginatedTopics(0, -1, callback);
    };
    Exporter.getPaginatedTopics = function(start, limit, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var prefix = Exporter.config('prefix');
        var startms = +new Date();
        var query = 'SELECT '
            + prefix + 'thread.threadid as _tid, '
            + prefix + 'post.userid as _uid, '
            + prefix + 'thread.forumid as _cid, '
            + prefix + 'post.title as _title, '
            + prefix + 'post.pagetext as _content, '
            + prefix + 'post.username as _guest, '
            + prefix + 'post.ipaddress as _ip, '
            + prefix + 'post.dateline as _timestamp, '
            + prefix + 'thread.views as _viewcount, '
            + prefix + 'thread.open as _open, '
            + prefix + 'thread.deletedcount as _deleted, '
            + prefix + 'thread.sticky as _pinned '
            + 'FROM ' + prefix + 'thread '
            + 'JOIN ' + prefix + 'post ON ' + prefix + 'thread.firstpostid=' + prefix + 'post.postid '
            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

        Exporter.query(query,
            function(err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }

                //normalize here
                var map = {};
                rows.forEach(function(row) {
                    row._title = row._title ? row._title[0].toUpperCase() + row._title.substr(1) : 'Untitled';
                    row._timestamp = ((row._timestamp || 0) * 1000) || startms;
                    row._locked = row._open ? 0 : 1;

                    map[row._tid] = row;
                });

                callback(null, map);
            });
    };

    Exporter.getPosts = function(callback) {
        return Exporter.getPaginatedPosts(0, -1, callback);
    };
    Exporter.getPaginatedPosts = function(start, limit, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var prefix = Exporter.config('prefix');
        var startms = +new Date();
        var query = 'SELECT '
            + prefix + 'post.postid as _pid, '
            + prefix + 'post.threadid as _tid, '
            + prefix + 'post.userid as _uid, '
            + prefix + 'post.username as _guest, '
            + prefix + 'post.ipaddress as _ip, '
            + prefix + 'post.pagetext as _content, '
            + prefix + 'post.dateline as _timestamp '
            + 'FROM ' + prefix + 'post WHERE ' + prefix + 'post.parentid<>0 '
            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

        Exporter.query(query,
            function(err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }

                //normalize here
                var map = {};
                rows.forEach(function(row) {
                    row._content = row._content || '';
                    row._timestamp = ((row._timestamp || 0) * 1000) || startms;
                    map[row._pid] = row;
                });

                callback(null, map);
            });
    };

    Exporter.teardown = function(callback) {
        Exporter.log('teardown');
        Exporter.connection.end();

        Exporter.log('Done');
        callback();
    };

    Exporter.testrun = function(config, callback) {
        async.series([
            function(next) {
                Exporter.setup(config, next);
            },
            function(next) {
                Exporter.getUsers(next);
            },
            function(next) {
                Exporter.getMessages(next);
            },
            function(next) {
                Exporter.getCategories(next);
            },
            function(next) {
                Exporter.getTopics(next);
            },
            function(next) {
                Exporter.getPosts(next);
            },
            function(next) {
                Exporter.teardown(next);
            }
        ], callback);
    };

    Exporter.paginatedTestrun = function(config, callback) {
        async.series([
            function(next) {
                Exporter.setup(config, next);
            },
            function(next) {
                Exporter.getPaginatedUsers(0, 1000, next);
            },
            function(next) {
                Exporter.getPaginatedMessages(0, 1000, next);
            },
            function(next) {
                Exporter.getPaginatedCategories(0, 1000, next);
            },
            function(next) {
                Exporter.getPaginatedTopics(0, 1000, next);
            },
            function(next) {
                Exporter.getPaginatedPosts(1001, 2000, next);
            },
            function(next) {
                Exporter.teardown(next);
            }
        ], callback);
    };

    Exporter.warn = function() {
        var args = _.toArray(arguments);
        args.unshift(logPrefix);
        console.warn.apply(console, args);
    };

    Exporter.log = function() {
        var args = _.toArray(arguments);
        args.unshift(logPrefix);
        console.log.apply(console, args);
    };

    Exporter.error = function() {
        var args = _.toArray(arguments);
        args.unshift(logPrefix);
        console.error.apply(console, args);
    };

    Exporter.config = function(config, val) {
        if (config != null) {
            if (typeof config === 'object') {
                Exporter._config = config;
            } else if (typeof config === 'string') {
                if (val != null) {
                    Exporter._config = Exporter._config || {};
                    Exporter._config[config] = val;
                }
                return Exporter._config[config];
            }
        }
        return Exporter._config;
    };

    // from Angular https://github.com/angular/angular.js/blob/master/src/ng/directive/input.js#L11
    Exporter.validateUrl = function(url) {
        var pattern = /^(ftp|http|https):\/\/(\w+:{0,1}\w*@)?(\S+)(:[0-9]+)?(\/|\/([\w#!:.?+=&%@!\-\/]))?$/;
        return url && url.length < 2083 && url.match(pattern) ? url : '';
    };

    Exporter.truncateStr = function(str, len) {
        if (typeof str != 'string') return str;
        len = _.isNumber(len) && len > 3 ? len : 20;
        return str.length <= len ? str : str.substr(0, len - 3) + '...';
    };

    Exporter.whichIsFalsy = function(arr) {
        for (var i = 0; i < arr.length; i++) {
            if (!arr[i])
                return i;
        }
        return null;
    };

})(module.exports);
