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

const flows = {};
const messagesToTrace = {};

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
                flows[node.id] = node;
                node.tracer = createTracer(node)
            }
        });
        checkAllParentSpanIsReadyToCloseRecursive();
    });

    function checkAllParentSpanIsReadyToCloseRecursive() {
        for (let msgId in messagesToTrace) {
            checkIfParentSpanIsReadyToClose(msgId);
        }
        setTimeout(checkAllParentSpanIsReadyToCloseRecursive, 10000);
    }

    //Limpa a memoria das mensagens que já foram/deveriam ter sido terminadas
    function deleteOldMessageSpans(msgId) {
        this.msgId = msgId;
        setTimeout(() => {
            delete messagesToTrace[msgId];
        }, 15 * 60 * 1000); //15 minutos
    }

    //Verifica se todos as spans que foram criadas dentro da span pai estão terminadas, e solicita pra terminar a pai
    function checkIfParentSpanIsReadyToClose(msgId) {
        let spans = messagesToTrace[msgId].spans;
        let readyToClose = true;
        for (let spanIdx in spans) {
            if (spans[spanIdx].active) {
                //ainda tem ativos, ignorar;
                readyToClose = false;
                return;
            }
        }
        if (readyToClose) {
            messagesToTrace[msgId].parentSpan.setStatus({ code: SpanStatusCode.OK });
            messagesToTrace[msgId].parentSpan.end();
            //Limpar apenas depois de varios minutos para garantir que nenhuma mensagem perdida não esteja esperano pra retornar
            deleteOldMessageSpans(msgId);
        }
    }

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
     * Caso a span parant ainda não exista, cria uma span raiz e adiciona umaa span filha com a mensagem atual
     * Se a span parant ja existir, só adiciona a nova span na parent
     * @param {*} tracer 
     * @param {*} nodeId 
     * @param {*} msgId 
     * @param {*} nodeName 
     * @param {*} flowName 
     * @param {*} node 
     * @param {*} msg 
     * @param {*} sourceNode 
     * @returns undefined
     */
    function createParentOrSpanBase(tracer, nodeId, msgId, nodeName, flowName, node, msg, sourceNode, propagationHeaders) {
        if (node.type === 'debug') { //se for nó de debug, podemos ignorar;
            return;
        }

        if (node.type === 'split') { //para evitar que fiquem span perdidas, salvamos o id da mensagem anterior
            msg.ozParentMessageId = msgId;
        }

        if (sourceNode && sourceNode.type === 'split' && msg.ozParentMessageId) {
            //É uma mensagem criada por um splitter            
            if (!messagesToTrace[msgId]) {
                messagesToTrace[msgId] = {
                    parentSpan: messagesToTrace[msg.ozParentMessageId].parentSpan,
                    ctx: messagesToTrace[msg.ozParentMessageId].ctx,
                    spans: messagesToTrace[msg.ozParentMessageId].spans
                }
            }
            delete msg.ozParentMessageId; //apagar dado da mesnagem pra evitar 'sujar' a mensagem
        }

        let activeContext = context.active();
        let first = false;
        if (!messagesToTrace[msgId]) {
            first = true;
            let fromRemote = false;
            if (propagationHeaders) {
                activeContext = propagation.extract(context.active(), propagationHeaders);
                const spanContext = trace.getSpanContext(activeContext);
                trace.setSpan(activeContext, spanContext);
                fromRemote = true;
            }
            let parentSpan = tracer.startSpan(flowName, {
                attributes: {}
            }, activeContext);
            messagesToTrace[msgId] = {
                parentSpan: parentSpan,
                ctx: fromRemote ? activeContext : trace.setSpan(activeContext, parentSpan),
                spans: {}
            }
        }
        //Criar o Span para este nó
        messagesToTrace[msgId].spans[nodeId] = {
            span: tracer.startSpan(nodeName, {
                attributes: {}
            }, messagesToTrace[msgId]['ctx']),
            active: true
        }
        messagesToTrace[msgId].ctx = trace.setSpan(activeContext, messagesToTrace[msgId].spans[nodeId].span);
    }

    /**
     *  Hooks para as mensagens
     *  onSend - a node has called send with one or more messages.
     *  preRoute - a message is about to be routed to its destination.
     *  preDeliver - a message is about to be delivered
     *  postDeliver - a message has been dispatched to its destination
     *  onReceive - a message is about to be received by a node
     *  postReceive - a message has been received by a node
     *  onComplete - a node has completed with a message or logged an error for it
    */

    /**
     * Adiciona um listner para criar span parent quando a mensagem não é criada/passada internamente.
     * Por exemplo, quando um httpin ou um inject são chamados
     */
    RED.hooks.add("preRoute", (sendEvents) => {
        let evt = sendEvents;
        let source = evt.source
        let node = source.node;
        let msg = evt.msg;
        let msgId = msg._msgid;
        let flowId = node.z;
        let flow = flows[flowId];
        let tracer = flow.tracer;
        let id = node.id;

        //Somente necessário para pegar o evento que vem do http-in, já que ele não vem de outra mensagem
        if ((node.type === 'http in' || node.type === 'inject')) {
            //Se vier de um http in, podemos pegar o traceid do client
            let propagationHeaders = null;
            if (node.type === 'http in' && msg.req.headers) {
                propagationHeaders = {
                    traceparent: msg.req.headers.traceparent,
                    tracestate: msg.req.headers.tracestate
                }
            }
            //Caso a mensagem ainda não tenha trace, criar a base do trace, não tem origim interna, src null
            createParentOrSpanBase(tracer, id, msgId, node.name, flow.name, node, msg, null, propagationHeaders)
        }

        /**
        

        //criar um span pra este nó
        messagesToTrace[msg._msgid][node.id] = tracer.startSpan(node.name, flow.name, messagesToTrace[msg._msgid]['ctx']);

        //para cada saida nó, vamos criar um span
        if(node.wires.length > 0 ){
            for (let id of node.wires[0]) {
                messagesToTrace[msg._msgid][id] = tracer.startSpan(node.name, flow.name, messagesToTrace[msg._msgid]['ctx']);
            }
        }


        //se for um http-in ou inject, vamos criar o span pai
        if ((node.type === 'http in' || node.type === 'inject')) {
            if (!msg.OZParentSpan) {
                msg.OZParentSpan = tracer.startSpan(flow.name);
            }
            const ctx = trace.setSpan(context.active(), msg.OZParentSpan);
            msg.OZSpan = {};
            for (let id of node.wires[0]) {
                msg.OZSpan[id] = tracer.startSpan(node.name, flow.name, ctx);
                if (msg.req) {
                    msg.OZSpan[id].setAttribute("headers", JSON.stringify(msg.req.headers));
                    msg.OZSpan[id].setAttribute("params", JSON.stringify(msg.req.params));
                    msg.OZSpan[id].setAttribute("query", JSON.stringify(msg.req.query));
                    msg.OZSpan[id].setAttribute("body", JSON.stringify(msg.req.body));
                } else {
                    msg.OZSpan[id].setAttribute("message", JSON.stringify(msg.payload));
                }
            }
        }
            //*/
    });



    /**
     * Adiciona um listner para criar span dentro do parent quando uma nova mensagem chega no node.
     * Este evento sempre ocorre de um node pra outro, mas não ocorre quando a chamada é externa, ex: httpin
     */
    RED.hooks.add("postDeliver", (sentEvent) => {
        let msg = sentEvent.msg;
        let msgId = msg._msgid;
        let destination = sentEvent.destination;
        let destinationNode = destination.node;
        let node = sentEvent.source.node;
        let sourceId = node.id;
        let id = node.id;
        let flowId = node.z;
        let flow = flows[flowId];
        let tracer = flow.tracer;

        //console.log("postDeliver", id, node.name, sourceNode.type, destination.node.type)
        if (destinationNode.type === 'http request' && messagesToTrace[msgId]) {
            if (!sentEvent.msg.headers) {
                sentEvent.msg.headers = {}
            }
            if (!sentEvent.msg.headers.traceparent) {
                const output = {};
                propagation.inject(messagesToTrace[msgId].ctx, output);
                sentEvent.msg.headers.traceparent = output.traceparent;
                sentEvent.msg.headers.tracestate = output.tracestate;
            }
        }

        //Pode ser que a mensagem seja criada no meio do caminho, se este for o caso, vamos tentar ver elas e criar um span
        if (!messagesToTrace[msgId]) {
            createParentOrSpanBase(tracer, id, msgId, node.name, flow.name, destinationNode, msg, node, null);
        }

        //Vamos terminar o span do source se ainda não estiver parado
        let sourceSpan = messagesToTrace[msgId].spans[sourceId];
        if (sourceSpan && sourceSpan.active) {
            sourceSpan.span.setStatus({ code: SpanStatusCode.OK });
            sourceSpan.span.end();
            sourceSpan.active = false;
        }

    });

    RED.hooks.add("onReceive", (receiveEvent) => {
        let msg = receiveEvent.msg;
        let msgId = msg._msgid;
        let destination = receiveEvent.destination;
        let node = destination.node;
        let flowId = node.z;
        let flow = flows[flowId];
        let tracer = flow.tracer;
        let id = node.id;

        //console.log("onReceive", id, node.name, node.type, msg)

        createParentOrSpanBase(tracer, id, msgId, node.name, flow.name, node, msg, null, null);
    });

    // Example onComplete hook
    RED.hooks.add("onComplete", (completeEvent) => {
        let msg = completeEvent.msg;
        let node = completeEvent.node.node;
        let id = node.id;

        /**
        .setStatus({
            code: SpanStatusCode.ERROR,
            message: err.message,
          });

        //console.log("onComplete", id, node.name, node.type, msg)

        /** 
        if (completeEvent.error) {
            completeEvent.msg.OZSpan[id].setStatus({ code: SpanStatusCode.ERROR });
            completeEvent.msg.OZSpan[id].setAttribute("error-message", completeEvent.error);
            completeEvent.msg.OZSpan[id].end();

            completeEvent.msg.OZParentSpan.setStatus({ code: SpanStatusCode.ERROR });
            completeEvent.msg.OZParentSpan.end()

            completeEvent.msg.OZParentSpan = null;
            completeEvent.msg.OZSpan = null;
        }
        // */

    });
};
