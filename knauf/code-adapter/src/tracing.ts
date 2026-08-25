import tracer from 'dd-trace';

// Only the bounded OpenTelemetry spans in middleware/telemetry.ts are emitted. Disabling
// auto-plugins prevents raw dynamic URLs/query values from becoming HTTP/Express span tags.
tracer.init({ plugins: false });
new tracer.TracerProvider().register();
