# _oztracer_ module for node-red

This node-red module add opentelemetry to Node-RED

All messages will be tracced into trace system,

if you like to have logs, you can add:
    **msg.logToAttribute**
        This option will add logs directly into the atributes of the span

    **msg.logToConsole**
        This option will send logs directly into the console, to be collected by promtail or grafana-agent