# Deploy an app

This page helps you deploy your app from Git to one of your project's environments.

Platform does not build your code. It deploys the Kubernetes files in your repository, using an image you have already built, for example with GitHub Actions or GitLab CI. Argo CD keeps the environment in sync with those files.

## What your repository needs

A folder with your Kubernetes files. Platform looks in `k8s` unless you choose another path. At minimum, add a Deployment and a Service that listens on **port 80**. Platform points the environment's address at that Service.

```text
your-repo/
  k8s/
    kustomization.yaml
    deployment.yaml
    service.yaml
```

```yaml
# k8s/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
```

```yaml
# k8s/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: shop
spec:
  selector:
    app: shop
  ports:
    - port: 80
      targetPort: 8080
```

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop
spec:
  replicas: 1
  selector:
    matchLabels:
      app: shop
  template:
    metadata:
      labels:
        app: shop
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: app
          image: ghcr.io/acme/shop:1.0.0
          ports:
            - containerPort: 8080
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
```

Leave out `namespace`. Platform puts each environment in its own namespace. Containers must run as a non-root user, as in the example, because project namespaces use the Kubernetes "restricted" security level. See [Namespace isolation](../namespace-isolation.md).

A working example lives in the repository at [`examples/sdk-demo/k8s`](https://github.com/Mpratyush54/SERVER-automation/tree/master/examples/sdk-demo/k8s).

## Deploy

1. Open your project and go to **Deployments**.
2. In **Deploy**, choose the **Target environment**, for example `development`.
3. Choose a **Branch or tag** and a **Commit**. Leave the commit empty to use the newest one.
4. If your files are not in `k8s`, enter the folder in **Manifests path in repo**.
5. Select **Pull from Git and deploy**.

The progress shows each step: apply the files, wait until the app is healthy, then finish. A deploy that is not healthy within about three minutes is marked as failed, with the reason.

When it succeeds, open the environment's address from **Environments** on the same page.

## Roll back or redeploy

- **Deployment history** lists every deploy. Select **Rollback** to go back to an earlier one.
- **Git releases** lists your repository's tags. Select **Deploy this version** to deploy a release.

## Preview a branch

A preview environment gives a branch its own short-lived address, so others can try a change before it is merged. See [Preview environments](../guides/preview-environments.md).

## Details

- **Which commit is used.** An explicit branch or commit wins. Otherwise the project's Git revision setting is used, then the repository's default branch. See [Branches and Argo CD](../gitops-branches.md).
- **Sync and refresh.** The project's Argo CD panel shows sync and health, and lets you refresh or sync an environment by hand.
- **Logs and metrics.** Once your app runs, see [Monitoring and alerts](../guides/monitoring.md).
- **Before going live.** Work through the [Production checklist](../guides/production-checklist.md).
