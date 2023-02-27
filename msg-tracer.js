const { context, metrics, propagation, SpanStatusCode, trace } = require('@opentelemetry/api');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { BasicTracerProvider, AlwaysOnSampler, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const fse = require('fs-extra');
const jsondiffpatch = require('jsondiffpatch');
const _ = require('lodash');
const cycle = require('./cycle.js');


const tracers = {};

const collectorOptions = {
    url: 'http://mhnet.ozmap.com.br:4318/v1/traces'
};
const oTLPTraceExporter = new OTLPTraceExporter(collectorOptions);
const spanProcessor = new BatchSpanProcessor(oTLPTraceExporter);

module.exports = function (RED) {
    const msgTracerConfigFolderPath = path.resolve(RED.settings.userDir, 'msg-tracer-config');
    const msgTracerConfigPath = path.join(msgTracerConfigFolderPath, 'local.json');
    const flowManagerConfig = JSON.parse(JSON.stringify(require('config')));
    const persistFlowManagerConfigFile = async function () {
        await fse.ensureDir(msgTracerConfigFolderPath);
        fs.writeFile(msgTracerConfigPath, JSON.stringify(flowManagerConfig), 'utf8', function () { });
    };


    RED.events.on('flows:started', function () {
        RED.nodes.eachNode(function (node) {
            if (node.type === 'tab' || node.type.startsWith('subflow:')) {
                tracers[node.id] = createTracer(node);
            }
        });
    });

    function createTracer(node) {
        let name = node.name || node.label;
        const provider = new BasicTracerProvider({
            generalLimits: {
                attributeValueLengthLimit: 2048,
                attributeCountLimit: 256
            },
            spanLimits: {
                attributeValueLengthLimit: 2048,
                attributeCountLimit: 256,
                linkCountLimit: 256,
                eventCountLimit: 256
            },
            sampler: new AlwaysOnSampler(),
            resource: new Resource({
                [SemanticResourceAttributes.SERVICE_NAME]: name,
            }),
        });
        provider.addSpanProcessor(spanProcessor);
        provider.register();
        return provider.getTracer('oztracer');
    }

    /**
     * 
     * @param {
     *    traceparent:string, 
     *    tracestate:string 
     * } propagationHeaders 
     * 
     * @returns Span
     */
    function extractSpanFromMessage(propagationHeaders) {
        activeContext = propagation.extract(context.active(), propagationHeaders);
        const spanContext = trace.getSpanContext(activeContext);
        trace.setSpan(activeContext, spanContext);
        return activeContext;
    }

    function setSpanOnMessage(msg, ctx) {
        const output = {};
        propagation.inject(ctx, output);
        if (!msg.headers) {
            msg.headers = {}
        }
        msg.headers.traceparent = output.traceparent;
        msg.headers.tracestate = output.tracestate;
    }

    const messageSpans = {};

    RED.hooks.add("preRoute", (sendEvents) => {
        const msg = sendEvents.msg;
        let msgId = msg._msgid;
        const source = sendEvents.source.node;
        const tracer = tracers[source.z];
        msg.oznsource = source.id;

        if (source.type == 'http request') { //Ocoree "nesse nodered" quando a mensagem volta
            try {
                let parent = messageSpans[msgId].spans[msg.oznsource].span;
                const ctx = trace.setSpan(context.active(), parent);
                let data = {
                    payload: msg.payload,
                    headers: msg.headers,
                    url: msg.responseUrl,
                    statusCode: msg.statusCode
                }
                //Span só pra marcar os dados de entrada
                const span = tracer.startSpan("response", {
                    attributes: {
                        response: JSON.stringify(data)
                    }
                }, ctx);
                span.end();
            } catch (e) {
                console.log(e);
            }
        }

        if (source.type === 'http in') { //ocorre no "outro nodered", quando a mensagem chega
            let propagationHeaders = {
                traceparent: msg.req.headers.traceparent,
                tracestate: msg.req.headers.tracestate
            }
            let ctx = extractSpanFromMessage(propagationHeaders)
            let mainSpan = tracer.startSpan(source.name, { attributes: {} }, ctx);
            messageSpans[msgId] = {
                main: mainSpan,
                spans: {}
            }

            /**
            let request = {
                payload: msg.payload,
                headers: msg.req.headers,
                query: msg.req.query,
                params: msg.req.params
            }
            ctx = trace.setSpan(context.active(), mainSpan);
            const span = tracer.startSpan(source.name, {
                attributes: {
                    request: JSON.stringify(request)
                }
            }, ctx);
            messageSpans[msgId].spans[source.id] = {
                span: span
            }
             */

        }
    });

    RED.hooks.add("onReceive", (sendEvents) => {
        const msg = sendEvents.msg;
        let msgId = msg._msgid;
        const destination = sendEvents.destination.node;
        const tracer = tracers[destination.z];

        if (msg.oznparentmessage) {
            msgId = msg.oznparentmessage;
        }
        if (destination.type === 'split') {
            msg.oznparentmessage = msgId;
        }
        if (!messageSpans[msgId]) { //Primeira span
            let mainSpan = tracer.startSpan('Main');
            messageSpans[msgId] = {
                main: mainSpan,
                spans: {}
            }
        }

        let parent = null;
        if (messageSpans[msgId].spans[msg.oznsource]) {
            parent = messageSpans[msgId].spans[msg.oznsource].span
        } else {
            parent = messageSpans[msgId].main;
        }


        const ctx = trace.setSpan(context.active(), parent);
        const span = tracer.startSpan(destination.name, { attributes: {} }, ctx);
        messageSpans[msgId].spans[destination.id] = {
            span: span
        }

        if (destination.type === "http request") { //Adiciona a mensagem no contexto
            setSpanOnMessage(msg, ctx);
        }
    });

    RED.hooks.add("onComplete", (completeEvent) => {
        let destination = completeEvent.node.node;
        const msg = completeEvent.msg;
        const msgId = msg.oznparentmessage ? msg.oznparentmessage : msg._msgid;
        const span = messageSpans[msgId].spans[destination.id]
        span.span.end();
        span.closed = true;

        let allClosed = false;
        for(let r in messageSpans[msgId].spans ){
            if(allClosed){
                return;
            }
            let theSpan = messageSpans[msgId].spans[r];
            allClosed =  theSpan.closed;
            console.log(theSpan.closed, theSpan.span.name);
        }
        if(allClosed){
            messageSpans[msgId].main.end();
        }
    })
};
