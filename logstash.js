const { context, metrics, propagation, trace } = require('@opentelemetry/api');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

const provider = new BasicTracerProvider({
    resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: 'basic-service',
    }),
});

const collectorOptions = {
    url: 'http://devops.ozmap.com.br:4318/v1/traces'
};

provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.addSpanProcessor(new SimpleSpanProcessor(new OTLPTraceExporter(collectorOptions)));
provider.register();

function createLogstashUDP(host, port) {
    return function (message, fields) {
        sendLog(message, fields);
    };
}

function sendLog(message, fields) {
    if (!mainSpan) {
        mainSpan = tracer.startSpan('main');
    }
    const ctx = trace.setSpan(context.active(), mainSpan);
    const span = tracer.startSpan('doWork', undefined, ctx);
    span.setAttribute('key', fields.nodered_tracer_step.msg);
    console.log("--------------- Iniciando log---------------------------------", message, '--->', fields);
    span.addEvent('invoking doWork');
    span.end();

    if (fields.nodered_tracer_step.node.type == "http response") {
        mainSpan.end();
        mainSpan = null;
    }

}

module.exports = createLogstashUDP;