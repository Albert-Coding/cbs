#!/bin/sh

if [ -f job.conf ]; then
	EXTARGS=$(grep '// -' job.conf | while read a b; do echo $b; done | tr '\n' ' ' | tr '\r' ' ')
	EXTJAR=$(grep '// jar=' job.conf | tr '=' ' ' | while read a b c; do echo $c; done | tr '\n' ' ' | tr '\r' ' ')
	if [ ! -z "${EXTJAR}" ]; then HYDRA_JAR=${EXTJAR}; fi
fi

eval exec ${JAVA_CMD:-java} \
	-server \
	-Xmx1G \
	-Xms1G \
	-XX:+AggressiveOpts \
	-XX:+UseParallelGC \
	-XX:+UseParallelOldGC \
	-Dcs.je.cacheSize=128M \
	-Dcs.je.cacheShared=1 \
	-Dcs.je.deferredWrite=1 \
	-Dhydra.query.age.max=120000 \
	-Dhydra.query.cache.max=4096 \
	-Dhydra.query.concurrent.timeout=180000 \
	-Dhydra.query.concurrent.max=10 \
	-Dhydra.query.debug=1 \
	-Dhydra.tree.cache.maxSize=100 \
	-Dhydra.tree.cache.maxMem=100M \
	-Dhydra.tree.page.maxSize=200 \
	-Dhydra.tree.page.maxMem=100k \
	-Dhydra.tree.mem.sample=0 \
	-Dhydra.tree.cleanqmax=100 \
	-Dhydra.tree.db=2 \
	-Dhydra.tree.trash.interval=1000 \
	-Dhydra.tree.trash.maxtime=100 \
	-Dmapper.localhost=${host} \
	-DnativeURLCodec=0 \
	-Dje.log.fileMax=100000000 \
	-Dje.cleaner.minUtilization=90 \
	-Dje.cleaner.threads=1 \
	-Dje.evictor.lruOnly=true \
	-Dje.evictor.nodesPerScan=100 \
	-Dtask.exit=1 \
	-Dtask.threads=4 \
	-Dtrak.event.debug=1 \
	-Dmapper.tree.type=1 \
	${EXTARGS} \
	${LOG4J_OPT} \
	-jar ${HYDRA_JAR} \
	task $*

