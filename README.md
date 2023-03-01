# _oztracer_ module for node-red

This node-red module add opentelemetry to Node-RED

All messages will be tracced into trace system,

if you like to have logs, you can add:


    **msg.OZTlogToAttribute**
        This option will add logs directly into the atributes of the span

    **msg.OZTlogToConsole**
        This option will send logs directly into the console, to be collected by promtail or grafana-agent

    **msg.OZTdoNotTrace**
        This force msg.OZTrace to ignore this message. Nothing will be logged. Use with caution, it may keep some traces open forever