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

    function createSpan() {
        let activeContext = context.active();
        let parentSpan = tracer.startSpan(flowName, {
            attributes: {}
        }, activeContext);
    }
    function extractSpanFromMessage() {
        activeContext = propagation.extract(context.active(), propagationHeaders);
        const spanContext = trace.getSpanContext(activeContext);
        trace.setSpan(activeContext, spanContext);

    }
    function setSpanOnMessage() {
        const output = {};
        propagation.inject(messagesToTrace[msgId].ctx, output);
        sentEvent.msg.headers.traceparent = output.traceparent;
        sentEvent.msg.headers.tracestate = output.tracestate;
    }


    const messageSpans = {}


    RED.hooks.add("postDeliver", (sendEvents) => {
        let msg = sendEvents.msg;
        msg.oznsource = sendEvents.source.node.id;
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

        let parent = messageSpans[msgId].spans[msg.oznsource] ? messageSpans[msgId].spans[msg.oznsource].span : messageSpans[msgId].main;
        const ctx = trace.setSpan(context.active(), parent);
        const span = tracer.startSpan(destination.name, { attributes: {} }, ctx);

        messageSpans[msgId].spans[destination.id] = {
            span: span

        }
    });

    RED.hooks.add("onComplete", (completeEvent) => {
        let destination = completeEvent.node.node;
        const msg = completeEvent.msg;
        const msgId = msg.oznparentmessage ? msg.oznparentmessage : msg._msgid;
        const span = messageSpans[msgId].spans[destination.id]
        span.span.end();
        span.closed = true;
    })
};
