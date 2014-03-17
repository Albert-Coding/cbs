(function() {

var busyimg = '<img width="32" height="32" src="spinner.gif">',
    db = localStorage || {},
    navstack = [ "" ],
    nodinfsho = 0,
    queries = [],
    render = 1,
    maxnav = dbGet('browse.max',25),
    tabs = ['completed-queries','browse','running-queries','setup'],
    tabSetting = "query.tab",
    // dict of query string kv-pairs
    qs = document.location.search.slice(1),
    qkv = qs.parseQuery(),
    jobid = qkv['job'] || dbGet('job'),
    // dict of hash kv-pairs
    hs = document.location.hash.slice(1),
    hkv = {},
    params = {},
    clusterData = {},
    auth=null,
    hostUpdater=null,
    liveQueryPolling=null,
	rpcroot="http://localhost:2222";

// dict of hash kv-pairs
try {
    var conv = unesc(hs);
    for (var i=0; i<2 && conv.indexOf("=")<0; i++) {
        conv = unesc(conv);
    }
    hkv = conv.parseQuery();
} catch(e){
    console.log(['hkv fail',e]);
}

/* escape ++ */
function esc(v) {
    return encodeURIComponent(v || '').replace('-','%2d');;
}

/* unescape ++ */
function unesc(v) {
    return decodeURIComponent(v || '');
}

var cbfuncs = {};
var nextcb = 0;

function callRPC(path, args, callback) {
	var fname = 'jsonp_cb'+(nextcb++);
	args = args || [];
	args.push("cbfunc-arg=\""+fname+"\"");
	args.push("cbfunc=QM.cbfuncs."+fname);
	path = rpcroot + path + '?' + args.join('&');
	var script = document.createElement('script');
	script.id = fname;
	script.type = 'text/javascript';
	script.src = path;

	cbfuncs[fname] = function(func, data) {
		if (callback) callback(data);
		delete cbfuncs[func];
		document.getElementById(func).remove();
	};
	
	var head = document.getElementsByTagName("head")[0];
	head.appendChild(script);
}

/* turn rpc response into an object */
function rpcDecode(data) {
    return data
}

/* hide and show selected elements */
function showTab(tab) {
    for (var i=0; i<tabs.length; i++) {
        var button = $('b_'+tabs[i]);
        var display = $(tabs[i]);
        if (tabs[i] == tab) {
            display.style.display = 'block';
            dbSet(tabSetting,tab);
        } else {
            display.style.display = 'none';
        }
    }
    stopHostPolling();
    stopLiveQueryPolling();
    switch (tab) {
        case 'completed-queries':
            cacheRescan();
            break;
        case 'running-queries':
            queriesRescan();
            break;
    }
}

/* format number with comma separators */
function fcsnum(n) {
    if (n == 0) {
        return n;
    }
    var pre = n < 0 ? "-" : "";
    var x = 1000;
    var a = [];
    n = Math.abs(n);
    while (n != 0) {
        var d = n % x;
        a.push(d/(x/1000));
        n -= d;
        x *= 1000;
    }
    a = a.reverse();
    for (var i=1; i<a.length; i++) {
        a[i] = a[i].toString();
        a[i] = '000'.substring(a[i].length)+a[i];
    }
    return pre+a.join(",");
}

/* decodes state from local storage */
function storedQueriesDecode() {
    var lsq = db['queries'] || null;
    queries = [];
    if (lsq) {
        lsq = lsq.split(',');
        for (var j=0; j<lsq.length; j++) {
            var q = unesc(lsq[j]).split(':');
            if (q.length == 4) {
                queries.push({name:unesc(q[0]),query:unesc(q[1]),ops:unesc(q[2]),rops:unesc(q[3])});
            }
        }
    }
}

/* encodes state to local storage */
function storedQueriesEncode() {
    var qc = [];
    for (var i=0; i<queries.length; i++) {
        var q = queries[i];
        qc.push(esc([esc(q.name),esc(q.query),esc(q.ops),esc(q.rops)].join(":")));
    }
    db['queries'] = qc;
}

/* sets or clears a cookie and re-encodes the lot */
function dbSet(c,v) {
    db[c] = v;
    storedQueriesEncode();
}

/* retrieves a cookie or returns a default if not set */
function dbGet(c,dv) {
    return db[c] || dv;
}

/* create quuery object from input fields */
function fieldsToQuery() {
    return {
        query:$('query').value,
        ops:$('qops').value,
        rops:$('qrops').value,
        name:$('qname').value
    };
}

/* populate input fields from query object */
function queryToFields(query) {
    $('query').value = query.query || '';
    $('qops').value = query.ops || '';
    $('qrops').value = query.rops || '';
    $('qname').value = query.name || '';
}

/* transfer nav to query */
function navToQuery(src,exec) {
    if (src) {
        queryToFields({query:navp + ':+json'});
    } else {
        queryToFields({query:navp + '/('+maxnav+')+:+count,+nodes,+mem',rops:'gather=ksaa',ops:'gather=ksaau;sort=0:s:a;title=key,count,nodes,mem,merge'});
    }
    if (exec) {
        doFormQuery();
    }
    return false;
}

/* rpc callback : render raw node */
function navNodeRaw(data) {
	console.log(['navNodeRaw',data]);
}

/* rpc callback : render node child list */
function renderNavQuery(r) {
	var t = '<table id="table_nav"><tr><th>node</th><th>count</th><th>nodes</th><th>mem</th><th>merge</th></tr>';
	for (var i=0; i<r.length; i++) {
		var d = UTF8.decode(r[i][0]);
		var s = d.replace(/</g,'&lt;').replace(/>/g,'&gt;');
		var oc = 'QM.treeNavTo(\''+esc(d)+'\','+r[i][2]+');'
		var os = 'QM.navToQuery(true,true);return false;'
		t += '<tr><td><a href="#" onclick="'+oc+'">'+s+'</a></td><td class="num">'+fcsnum(r[i][1])+'</td><td class="num">'+fcsnum(r[i][2])+'</td><td class="num">'+fcsnum(r[i][3])+'</td><td class="num">'+fcsnum(r[i][4])+'</td></tr>';
	}
	t += '</table>';
	$('nodelist').innerHTML = t;
}

/* get the real query url */
function queryRaw() {
    var query = fieldsToQuery();
    query.other = $('qother').value;
    var path = '/query/call?'+packQuery([['path',query.query],['ops',query.ops],['rops',query.rops],['format','json'],["job",jobid],['filename',query.name],["sender","spawn"],query.other]);
    alert(path);
    //console.log(path);
    return false;
}

/* export current query as csv */
function queryCSV() {
    var query = fieldsToQuery();
    query.other = $('qother').value;
    window.open('/query/call?'+packQuery([['path',query.query],['ops',query.ops],['rops',query.rops],['format','csv'],["job",jobid],['filename',query.name],["sender","spawn"],query.other]));
    return false;
}

/* save input fields as query */
function querySave() {
    queries.push(fieldsToQuery());
    storedQueriesShow();
    storedQueriesEncode();
    return false;
}

/* delete select query */
function queryDelete(i) {
    queries.splice(i,1);
    storedQueriesShow();
    storedQueriesEncode();
}

/* alter contents of select query */
function querySet(i,exec) {
    var q = queries[i];
    queryToFields(q);
    window.localStorage['lastQuery'] = packQuery([['path',q.query],['ops',q.ops],['rops',q.rops],['format','json'],['filename',q.name],$('qother').value]);
    if (exec) doFormQuery();
    return false;
}

/* render queries into box */
function storedQueriesShow() {
    var txt = '<table id="table_queries">';
    for (var i=0; i<queries.length; i++) {
        txt += '<tr>';
        txt += '<th><a title="delete" href="#" onclick="QM.queryDelete('+i+');return false;">&times;</a></th>';
        txt += '<th><a title="query" href="#" onclick="QM.querySet('+i+',true);return false;">&raquo;</a></th>';
        txt += '<td width=95%><a title="load" href="#" onclick="return QM.querySet('+i+',false)">'+(queries[i].name || queries[i].query)+'</a></td>';
        txt += '</tr>';
    }
    txt += '</table>';
    $('saved').innerHTML = txt;
}

/* called by <return> in input field */
function submitQuery(val,event,json) {
    dbSet("qother",$('qother').value);
    // only trigger query on a return/enter keypress
    switch (window.event ? window.event.keyCode : event ? event.which : 0) {
        case 13: doFormQuery(); return false;
    }
}

/* called by <return> in input field */
function queryCodec(val,event,action) {
    switch (window.event ? window.event.keyCode : event ? event.which : 0) {
        case 13:
            switch (action) {
                case 'encode':
                    callRPC('/query/encode', ['path='+esc(val)], function(data) {
                        $('o2q').value = data;
                    });
                    break;
                case 'decode':
                    callRPC('/query/decode', ['path='+esc(val)], function(data) {
                        $('q2o').value = data;
                    });
                    break;
            }
            return false;
    }
}

/* sent rpc to get a list of live queries from QueryMaster */
function cacheRescan() {
    callRPC('/completed/list', [], function(data) { renderCompletedEntries(data); });
}

/* sent rpc to get a list of live queries from QueryMaster */
function queriesRescan() {
    callRPC('/query/list', [], function(data) { renderLiveQueries(data); });
    if($('runningstatus').style.display=="block" && $('sel_run_uuid').innerHTML!=""){
        queryHostsRescan($('sel_run_uuid').innerHTML, $('sel_run_job').innerHTML);
    }
    //setup polling for new live queries    
    if(liveQueryPolling==null){
        liveQueryPolling=setInterval(function() {
			callRPC('/query/list', [], renderLiveQueries(data))
		}, 5000);
    }
    else{
        liveQueryPolling.start();
    }
}

/* sent rpc to get a list of hosts for a query from QueryMaster */
function queryHostsRescan(uuid,job) {
    var tab=dbGet(tabSetting);
    var request = callRPC('/host/list', ['uuid='+uuid], function(data) { renderQueryHosts(data,tab); });
    switch (tab) {
        case 'completed-queries':
            $('sel_compl_uuid').update(uuid);
            $('sel_compl_job').update(job);
            $('completedhosts').update("");            
            // $('sel_compl_progress').innerHTML ="-"; 
            break;
        case 'running-queries':
            $('sel_run_uuid').update(uuid);
            $('sel_run_job').update(job);  
            $('runninghosts').update(""); 
            $('sel_run_progress').innerHTML ="-";         
            stopHostPolling();
            if (hostUpdater==null) {
                hostUpdater=setInterval(function() {
                    callRPC('/host/list', ['uuid='+$('sel_run_uuid').innerHTML], function(data) { renderQueryHosts(data,'runningqueries'); });
                }, 2000);
            }
            break;
    }    
}

function renderQueryHosts(hosts,tab){
    // console.log("unsorted:"+hosts);
    var html = '<table><tr><th>';
    html += ['hostname','lines','start time',(tab=='runningqueries'? 'run time':'end time'),'finished'].join('</th><th>')+'</th></tr>';
    var finished=0;
    if(hosts.length>0) {
        hosts=$(hosts).sortBy(function(el){ return el.runtime;}).reverse();
        // console.log("sorted:"+hosts);
    }       
    for (var i=0; i<hosts.length; i++) {
        var h = hosts[i];
        var row = [h.hostname, h.lines, new Date(h.starttime).toString('yy/MM/dd HH:mm:ss')||'-', (tab=='runningqueries'? (h.runtime/1000.0)+"s" :  (h.endtime>0? new Date(h.endtime).toString('yy/MM/dd HH:mm:ss'):'-') ), (h.finished=="true"?"y":"n")];
        html += '<tr><td>'+row.join('</td><td>')+'</td></tr>';
        finished+=(h.finished=="true"?1:0);
    }
    html += '</table>';
    // var tab=dbGet(tabSetting);
    switch (tab) {
        case 'completed-queries':
            $('completedhosts').innerHTML = html;
            show('completedstatus');
            show('completedhosts');
            break;
        case 'running-queries':
            $('runninghosts').innerHTML = html; 
            var progress = (((finished/1.00)/hosts.length)*100.0);
            // $('sel_run_progress').innerHTML = (isNaN(progress) || (progress==0) )?"-":progress+"%";
             $('sel_run_progress').innerHTML = (hosts.length>0? finished+"/"+hosts.length:"-");
            show('runningstatus');
            show('runninghosts');
            break;
    }
    // $('completedstatus').style.display='block';
    // $('completedhosts').style.display='block';
}

function show(el){
    $(el).style.display='block';
}

function hide(el){
    $(el).style.display='none';
}

/* encode query arg array */
function packQuery(a) {
    var na = [];
    for (var i=0; i<a.length; i++) {
        if (!a[i]) {
            continue;
        }
        if (typeof(a[i]) == 'object') {
            na.push(packKV(a[i][0],a[i][1]));
        } else {
            na.push(a[i])
        }
    }
    return na.join('&');
}

/* encode query key/value pair */
function packKV(k,v) {
    return v && v != '' ? k+'='+esc(v) : '';
}

/* perform actual AJAX query */
function doQuery(query, callback, cacheBust) {
    var params = [['path',query.query],['ops',query.ops],['rops',query.rops],['format','json'],["job",jobid],["sender","spawn"],query.other];
    if (cacheBust) {
        params.push(['nocache','1']);
    }
    callRPC('/query/call', [packQuery(params)], callback);
    return false;
}

/* cancel running query */
function killLiveQuery(uuid) {
    callRPC('/query/cancel', ['uuid='+uuid], function(data) { alert(data); queriesRescan(); });
}

/* render queries live on QueryMaster */
function renderLiveQueries(live) {
    renderCacheList(live, 'queries', 'killLiveQuery');
}

/* render cache entries minus live */
function renderCompletedEntries(cache) {
    renderCacheList(cache, 'completed');
}

function limit(txt,chars) {
    if (!txt) { return txt; }
    var t = txt.toString();
    if (t.length > chars) {
        return t.substring(0, chars)+" ...";
    }
    return txt;
}

/* cache entry list render */
function renderCacheList(list,div,kill) {
    var html = '<table><tr><th>';
    html += ['submit','uuid','alias','job','path','ops','run','lines','kill'].join('</th><th>')+'</th></tr>';
    for (var i=0; i<list.length; i++) {
        var le = list[i];
        var row = [new Date(le.startTime).toString('yy/MM/dd HH:mm:ss'), "<a onclick='QM.queryHostsRescan(\""+le.uuid+"\",\""+le.job+"\")' href='#'>"+le.uuid+"</a>", le.alias || '', limit(le.job,15), limit(le.path,80), limit(le.ops,40), fcsnum(le.runTime), fcsnum(le.lines), '<a href="#" onclick="QM.'+kill+'(\''+le.uuid+'\')">x</a>'];
        html += '<tr><td>'+row.join('</td><td>')+'</td></tr>';
    }
    html += '</table>';
    $(div).innerHTML = html;
}

/* do query with UI wrappings */
function doFormQuery() {
    $('queryinfo').innerHTML = busyimg;
    var q = fieldsToQuery();
    q.other = $('qother').value;
    doQuery(q, renderFormQueryResults, true);
    document.location.hash = '#'+esc(esc(Object.toQueryString(q)));
    return false;
}

/* handle AJAX query callback */
function renderFormQueryResults(table) {
    var src = '';
    if (render != 0) {
        src = '<table id="table_results">';
        for (var i=0; i<table.length; i++) {
            var row = table[i];
            src += '<tr>';
            for (var j=0; j<row.length; j++) {
                src += renderQueryValue(row[j]);
            }
            src += '</tr>';
        }
        src += '</table>';
    } else {
        src = '';
    }
    $('queryinfo').innerHTML = src;
}

/* try to determine numbers and non-numbers */
function renderQueryValue(v) {
    if (v == null) v = '';
    if (typeof(v) !== 'number') {
        v = v.toString();
        if (v.match(/^[1-9][0-9]*$/) != null) {
            v = parseInt(v);
        } else {
            var str = UTF8.decode(v).replace(/</g,'&lt;').replace(/>/g,'&gt;');
            if (v.match(/{.*}/)) {
                if (str.length > 40) str = JSON.stringify(JSON.parse(str),null,4);
                str = prettyPrintOne(str,"js");
            }
            return '<td>'+str+'</td>';
        }
    }
    if (v % 1 !== 0) {
        return '<td class="num">'+v+'</td>';
    }
    return '<td class="num">'+fcsnum(v)+'</td>';
}

/* render nav stack */
function treeNavStack() {
    var navt = '';
    for (var i=0; i<navstack.length; i++) {
        var txt = i > 0 ? navstack[i] : '...';
        if (txt.length > 20) {
            txt = txt.substring(0,17)+"...";
        }
        navt += '<a href="..." onclick="QM.treeNavUp('+(i+1)+');return false;">'+unescape(txt)+'</a> / ';
    }
    $('treenav').innerHTML = navt;
    navp = navstack.length > 1 ? navstack.slice(1).join("/") : "";
    $('nodelist').innerHTML = busyimg;
    doQuery({query:navp + '/('+maxnav+')+:+count,+nodes,+mem',ops:'gather=ksaau;sort=0:s:a',other:$('qother').value},renderNavQuery,true);
    if (navstack.length > 0 && dbGet('raw') == '1') doQuery({query:navp+':+json',other:$('qother').value}, navNodeRaw, true);
}

/* pop nav stack */
function treeNavUp(idx) {
    while (navstack.length > idx) {
        navstack.pop();
    }
    treeNavStack();
}

/* push nav stac */
function treeNavTo(node,children) {
    if (children == 0) {
        $('nodelist').innerHTML = '';
    }
    navstack.push(node);
    treeNavStack();
}

function toggleGraphOptions() {
	if ($('graph_type_buttons').innerHTML == "") {
		    $('graph_type_buttons').innerHTML = '<button onclick="QM.chooseGraph(\'line\')">line graph</button>';
	} else {
		$('graph_type_buttons').innerHTML = '';
		$('graph_config').innerHTML = '';
		$('graph_display').innerHTML = '';
	}

}

function chooseGraph(type) {
    var config = '';
    config += '<table id="graph_config" cellspacing=1 cellpadding=1 border=0 width=100%>';
    config += '<tr><td>X Columns</td><td><input id="xcols" type="text" value="0"/></td></tr>';
    config += '<tr><td>Y Columns</td><td><input id="ycols" type="text" value="1"/></td></tr>';
    config += '</table>';
    config += '<button onclick="QM.graphIt(\'' + type + '\')">graph it</button>';
    $('graph_config').innerHTML = config;
}

function renderLineGraph(table) {
    $('graph_display').innerHTML = '<div id="graph" style="width:100%;height:300px;"></div>';

    var _$ = jQuery.noConflict();
    var y_cols = $('ycols').value.split(',');
    var x_cols = $('xcols').value.split(',');
    var tcks = [];
    var data = [];
    for (var i=0; i<table.length; i++){
        var x_keys = [];
        for (var x_col_i=0; x_col_i < x_cols.length; x_col_i++) {
            var x = table[i][parseInt(x_cols[x_col_i])];
            x_keys.push(x);
        }
        var x_val = x_keys.join(' ');
        tcks.push([i, x_val]);
        for (var y_col_i = 0; y_col_i < y_cols.length; y_col_i++) {
            var col_data = y_col_i < data.length ? data[y_col_i].data : [];
            var index = parseInt(y_cols[y_col_i]);
            var y = table[i][index];
            if (isNaN(y)){
                continue;
            }
            col_data.push([i,y])
            var y_label = isNaN(table[0][index]) ? table[0][index] : index;
            data[y_col_i] = { data: col_data, label: y_label};
        }
    }
    var num_ticks = tcks.length;
    var max_ticks = 8;
	if (num_ticks > max_ticks) {
		var reduced_ticks = [];
		for (var i=0; i<max_ticks; i++) {
			reduced_ticks.push(tcks[Math.floor(i * num_ticks / max_ticks)]);
		}
		tcks = reduced_ticks;
	}
    var options = { xaxis : {ticks:tcks}};
    _$.plot(_$("#graph"), data , options);
}

function graphIt(type) {
    var q = fieldsToQuery();
    q.other = $('qother').value;
    if (type == 'line') {
        doQuery(q, renderLineGraph, true);
    }
}

function closeRunningHosts(){
    hide('runninghosts');
    hide('runningstatus');
    //stop hostUpdater
    stopHostPolling();
}

function stopHostPolling(){
    if(hostUpdater!=null){
        clearInterval(hostUpdater);
        hostUpdater=null;
    }
}

function stopLiveQueryPolling(){
    if(liveQueryPolling!=null){
    //     clearInterval(liveQueryPolling);
    //     liveQueryPolling=null;
    // }
    // else{
        clearInterval(liveQueryPolling);
        liveQueryPolling=null;
    }
}

function closeCompletedHosts(){
    hide('completedhosts');
    hide('completedstatus');
}


/* called on page load  */
function init() {
    params = decodeParams();

    if (params.cluster) {
        var clusterString = db['cluster-'+params.cluster];
        if (clusterString) {
            clusterData = JSON.parse(clusterString);
            if (!clusterData.isLocal) rpcroot="http://"+firstKey(clusterData.proc.qmaster)+":2222"
            auth = clusterData.authKey;
        }
    }

    storedQueriesDecode();
    
    // Populate query fields from URL (use hash, then query string)
    $('qname').value  = hkv.name   || '';
    $('query').value  = hkv.query  || '';
    $('qops').value   = hkv.ops    || '';
    $('qrops').value  = hkv.rops   || '';
    $('qother').value = hkv.qother || dbGet('qother', '');
    
    if ($('query').value) {
        doFormQuery();
    }
    
    treeNavStack();
    storedQueriesShow();

    showTab(dbGet(tabSetting,'browse'));
    dbSet('job',jobid);
}

window.QM = {
    init : init,
    showTab : showTab,
    queryCodec : queryCodec,
    queryRaw : queryRaw,
    queryCSV : queryCSV,
    querySave : querySave,
    querySet : querySet,
    queryDelete : queryDelete,
    submitQuery : submitQuery,
    navToQuery : navToQuery,
    treeNavUp : treeNavUp,
    treeNavTo : treeNavTo,
    toggleGraphOptions : toggleGraphOptions,
    chooseGraph : chooseGraph,
    graphIt : graphIt,
    killLiveQuery : killLiveQuery,
    queryHostsRescan: queryHostsRescan,

    show:show,
    hide:hide,
    closeRunningHosts: closeRunningHosts,
    closeCompletedHosts: closeCompletedHosts,

	cbfuncs:cbfuncs
};

})();

