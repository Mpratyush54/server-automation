const fs = require('fs');
const path = require('path');

const docsDir = __dirname;

function replaceInFile(relativePath, replacements) {
    const filePath = path.join(docsDir, relativePath);
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        return;
    }
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    for (const { from, to } of replacements) {
        const newContent = content.replace(from, to);
        if (newContent !== content) {
            content = newContent;
            modified = true;
        } else {
            console.warn(`Replacement not found in ${relativePath}: ${from}`);
        }
    }

    if (modified) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`Updated ${relativePath}`);
    }
}

// 1. deploy-your-app.md
replaceInFile('getting-started/deploy-your-app.md', [
    { from: /https:\/\/pr-\{number\}-\{project\}\.sslip\.io\//g, to: 'https://{project-slug}-{sanitized-branch}.preview.{DOMAIN}' }
]);

// 4. python-sdk-quickstart.md
replaceInFile('getting-started/python-sdk-quickstart.md', [
    { from: /os\.environ\.get\('NODE_ENV'\)/g, to: "os.environ.get('ENVIRONMENT', 'production')" }
]);

// 5. secrets-management.md
replaceInFile('guides/secrets-management.md', [
    { from: /await client\.start\(\);/g, to: 'await client.init();' }
]);

// 7. architecture/database-schema.md
replaceInFile('architecture/database-schema.md', [
    { from: /arguCDAppName/g, to: 'argoCDAppName' }
]);

// 8. k8s-infrastructure.md & network-topology.md
replaceInFile('architecture/k8s-infrastructure.md', [
    { from: /namespace:\s*postgres/g, to: 'namespace: databases' },
    { from: /namespace:\s*mongo/g, to: 'namespace: databases' },
    { from: /namespace:\s*redis/g, to: 'namespace: databases' }
]);
replaceInFile('architecture/network-topology.md', [
    { from: /namespace:\s*postgres/g, to: 'namespace: databases' },
    { from: /namespace:\s*mongo/g, to: 'namespace: databases' },
    { from: /namespace:\s*redis/g, to: 'namespace: databases' }
]);

// 9. update-secrets.md
replaceInFile('deployment/update-secrets.md', [
    { from: /caps-platform-env/g, to: 'platform-env' },
    { from: /namespace caps/g, to: 'namespace platform' },
    { from: /\/etc\/caps\/\.env/g, to: '/etc/platform/.env' }
]);

// 11. sdk-python/PlatformClient.md
replaceInFile('api-reference/sdk-python/PlatformClient.md', [
    { from: /\/api\/config/g, to: '/api/sdk/config' }
]);

// 12. index.md
replaceInFile('index.md', [
    { from: /https:\/\/github\.com\/your-org\/platform\.git/g, to: 'https://github.com/your-username/SERVER-automation.git' },
    { from: /curl http:\/\/localhost:3000\/api\/users\/init-demo/g, to: 'npm run seed:db' }
]);

// 14. api-seed-failure.md
replaceInFile('troubleshooting/api-seed-failure.md', [
    { from: /deployment\/api-deployment/g, to: 'deployment/api' }
]);

// 15. minio-template-error.md
replaceInFile('troubleshooting/minio-template-error.md', [
    { from: /caps-logs/g, to: 'platform-logs' },
    { from: /caps/g, to: 'platform' }
]);

console.log("Done");
