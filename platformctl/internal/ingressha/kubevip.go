package ingressha

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
	"text/template"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

var ifaceNameRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,14}$`)

// KubeVIPManifest renders the kube-vip RBAC + DaemonSet multi-document YAML
// for ARP mode with per-Service election (and optional control-plane VIP).
func KubeVIPManifest(c *config.Config, iface string) (string, error) {
	if c == nil {
		return "", fmt.Errorf("nil config")
	}
	iface = strings.TrimSpace(iface)
	if !ifaceNameRE.MatchString(iface) {
		return "", fmt.Errorf("invalid VIP interface name %q", iface)
	}
	apiVIP := strings.TrimSpace(c.APIVIP)
	if apiVIP != "" {
		if strings.ContainsAny(apiVIP, "\r\n\"'\\") {
			return "", fmt.Errorf("API_VIP contains unsafe characters")
		}
	}
	data := kubeVIPTemplateData{
		Image:    versions.KubeVIPImage,
		Iface:    iface,
		APIVIP:   apiVIP,
		CPEnable: apiVIP != "",
	}
	var buf bytes.Buffer
	if err := kubeVIPTemplate.Execute(&buf, data); err != nil {
		return "", err
	}
	return buf.String(), nil
}

type kubeVIPTemplateData struct {
	Image    string
	Iface    string
	APIVIP   string
	CPEnable bool
}

// yamlQuote escapes a string as a double-quoted YAML scalar.
func yamlQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\', '"':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

var kubeVIPTemplate = template.Must(template.New("kube-vip").Funcs(template.FuncMap{"q": yamlQuote}).Parse(`apiVersion: v1
kind: ServiceAccount
metadata:
  name: kube-vip
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: system:kube-vip-role
rules:
  - apiGroups: [""]
    resources: ["services/status"]
    verbs: ["update"]
  - apiGroups: [""]
    resources: ["services", "endpoints"]
    verbs: ["list", "get", "watch", "update"]
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["list", "get", "watch", "update", "patch"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["list", "get", "watch", "update", "create"]
  - apiGroups: ["discovery.k8s.io"]
    resources: ["endpointslices"]
    verbs: ["list", "get", "watch", "update"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: system:kube-vip-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:kube-vip-role
subjects:
  - kind: ServiceAccount
    name: kube-vip
    namespace: kube-system
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kube-vip-ds
  namespace: kube-system
  labels:
    app.kubernetes.io/name: kube-vip
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: kube-vip
  template:
    metadata:
      labels:
        app.kubernetes.io/name: kube-vip
    spec:
      hostNetwork: true
      serviceAccountName: kube-vip
      priorityClassName: system-node-critical
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: node-role.kubernetes.io/control-plane
                    operator: Exists
      tolerations:
        - operator: Exists
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
      containers:
        - name: kube-vip
          image: {{ q .Image }}
          args: ["manager"]
          securityContext:
            capabilities:
              add: ["NET_ADMIN", "NET_RAW"]
              drop: ["ALL"]
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 200m
              memory: 128Mi
          env:
            - name: vip_arp
              value: "true"
            - name: vip_interface
              value: {{ q .Iface }}
            - name: svc_enable
              value: "true"
            - name: svc_election
              value: "true"
            - name: vip_leaseduration
              value: "5"
            - name: vip_renewdeadline
              value: "3"
            - name: vip_retryperiod
              value: "1"
            - name: prometheus_server
              value: ":2112"
{{- if .CPEnable }}
            - name: cp_enable
              value: "true"
            - name: cp_namespace
              value: "kube-system"
            - name: address
              value: {{ q .APIVIP }}
            - name: port
              value: "6443"
            - name: vip_leaderelection
              value: "true"
            - name: vip_leasename
              value: "plndr-cp-lock"
{{- else }}
            - name: cp_enable
              value: "false"
{{- end }}
`))
