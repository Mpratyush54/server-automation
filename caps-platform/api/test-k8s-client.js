const k8s = require('@kubernetes/client-node');
const kc = new k8s.KubeConfig();

try {
  console.log('Loading default KubeConfig...');
  kc.loadFromDefault();
  
  const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
  console.log('Attempting to list namespaces...');
  
  k8sApi.listNamespace()
    .then(res => {
      console.log('SUCCESS: Successfully connected to Kubernetes cluster!');
      // Check signature depending on client library version
      const items = res.body ? res.body.items : res.items;
      console.log('Namespaces found:', items.map(ns => ns.metadata.name));
    })
    .catch(err => {
      console.error('ERROR: Failed to list namespaces:', err.message);
      if (err.response) {
        console.error('Response status:', err.response.statusCode);
        console.error('Response body:', err.response.body);
      }
    });
} catch (err) {
  console.error('ERROR: Failed to load KubeConfig:', err.message);
}
