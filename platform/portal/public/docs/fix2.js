const fs = require('fs');
const path = require('path');
const docsDir = __dirname;

function replaceInFile(relativePath, replacements) {
    const filePath = path.join(docsDir, relativePath);
    if (!fs.existsSync(filePath)) return;
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    for (const { from, to } of replacements) {
        const newContent = content.replace(from, to);
        if (newContent !== content) {
            content = newContent;
            modified = true;
        }
    }

    if (modified) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`Updated ${relativePath}`);
    }
}

replaceInFile('getting-started/installation.md', [
    { from: /admin@platform\.local/g, to: 'admin@pratyushes.dev' },
    { from: /and the password `admin123`/g, to: 'and wait for the one-time magic link (passwordless authentication)' }
]);

replaceInFile('architecture/overview.md', [
    { from: /subgraph ControlPlane\["Control Plane"\]\n        Browser\["Browser\/Client"\]/g, to: 'Browser["Browser/Client"]\n    subgraph ControlPlane["Control Plane"]' }
]);

replaceInFile('deployment/update-secrets.md', [
    { from: /namespace caps/g, to: 'namespace platform' }
]);

replaceInFile('architecture/k8s-infrastructure.md', [
    { from: /namespace: caps/g, to: 'namespace: platform' }
]);

replaceInFile('architecture/network-topology.md', [
    { from: /namespace: caps/g, to: 'namespace: platform' }
]);
