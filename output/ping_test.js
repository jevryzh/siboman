(() => {
  const PROTO = "__zhumeng_proto";
  const PROTO_VAL = "zhumeng-v1";
  return new Promise(resolve => {
    const reqId = 'test-ping-' + Date.now();
    const handler = (e) => {
      const d = e.data;
      if (d && d[PROTO] === PROTO_VAL && d.reqId === reqId) {
        window.removeEventListener('message', handler);
        resolve(JSON.stringify({
          ping_sent: true,
          response_received: true,
          ok: d.ok,
          version: d.version,
          kind: d.kind,
        }));
      }
    };
    window.addEventListener('message', handler);
    window.postMessage({ [PROTO]: PROTO_VAL, kind: 'ping.request', reqId }, '*');
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(JSON.stringify({
        ping_sent: true,
        response_received: false,
        timeout: true,
      }));
    }, 5000);
  });
})()