const { HoneycombSDK } = require('@honeycombio/opentelemetry-node');
const { context, metrics, propagation, trace } = require('@opentelemetry/api');
const {
    getNodeAutoInstrumentations,
} = require('@opentelemetry/auto-instrumentations-node');
const { Resource } = require('@opentelemetry/resources');

const nodeTypesStartSpan = [
    "inject",
]

const nodeTypesEndSpan = [
    
]

const sdk = new HoneycombSDK({
    apiKey: 'K1otyjqN74KnPfwjysjZJB',
    serviceName: 'node-red-test',
    //debug: true,
    instrumentations: [getNodeAutoInstrumentations()],
    metricsDataset:
        'node-red-test-metrics',
    // add app level attributes to appear on every span
    resource: new Resource({
        'global.build_id': process.env.APP_BUILD_ID,
    }),
});


sdk.start()
    .then(() => {
        console.log('Tracing initialized');
    })
    .catch((error) => {
        console.log('Error initializing tracing', error)
    });


function createLogstashUDP(host, port) {
    return function (message, fields) {
        sendLog(message, fields);
    };
}

function sendLog(message, fields) {
    console.log("--------------- Iniciando log---------------------------------", message, '--->', fields);

    if(nodeTypesStartSpan.includes(fields.nodered_tracer_step.node.type)){
        fields.nodered_tracer_step.node.msg.spanIdPai = 1;
    }


    try {
        const tracer = trace.getTracer('message');
        tracer.startActiveSpan('sleep', (span) => {
            span.setAttribute('message', fields.nodered_tracer_step);
            span.end();
        })
    } catch (e) {
        console.error(e);
    }

}

module.exports = createLogstashUDP;

