{{/* Every object is named after the release: `helm install netatlas` makes `netatlas` and `netatlas-reader`. */}}
{{- define "netatlas.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "netatlas.selectorLabels" -}}
app.kubernetes.io/name: netatlas
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "netatlas.labels" -}}
{{ include "netatlas.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* "true" when some cluster is read with netatlas's own ServiceAccount, which the reader role and the mounted token serve. */}}
{{- define "netatlas.inCluster" -}}
{{- range .Values.clusters -}}
{{- if eq ((.login | default dict).type | default "") "inCluster" -}}true{{- end -}}
{{- end -}}
{{- end -}}

{{/* Where a token cluster's Secret is mounted; the registry points its token and CA files here. */}}
{{- define "netatlas.secretDir" -}}
/var/run/netatlas/clusters/{{ . }}
{{- end -}}

{{/* Where a cluster's Prometheus Secret is mounted; the registry points its auth files here. */}}
{{- define "netatlas.prometheusDir" -}}
/var/run/netatlas/prometheus/{{ . }}
{{- end -}}

{{/*
The registry file netatlas reads (clusters.yaml). A token cluster reads the token and CA its Secret
holds, and a Prometheus with bearer or basic auth reads the credentials its Secret holds, so their
entries name files under the Secret's mount instead of a secretName. Fields left out of the values
stay out, so netatlas's own checks name what is missing.
*/}}
{{- define "netatlas.registry" -}}
{{- /* netatlas refuses an empty registry at start, so fail the render instead of installing a pod that stops. */ -}}
{{- if not .Values.clusters -}}
{{- fail "clusters is empty: list at least one cluster for netatlas to read" -}}
{{- end -}}
{{- $clusters := list -}}
{{- range .Values.clusters -}}
{{- $login := .login | default dict -}}
{{- $type := $login.type | default "" -}}
{{- $c := dict "name" .name -}}
{{- if eq $type "inCluster" -}}
{{- $_ := set $c "login" (dict "type" "inCluster") -}}
{{- else -}}
{{- if .server }}{{ $_ := set $c "server" .server }}{{ end -}}
{{- if .caData }}{{ $_ := set $c "caData" .caData }}{{ end -}}
{{- if eq $type "token" -}}
{{- if not $login.secretName -}}
{{- fail (printf "cluster %q uses token login, so it needs login.secretName" .name) -}}
{{- end -}}
{{- $dir := include "netatlas.secretDir" .name -}}
{{- if not .caData }}{{ $_ := set $c "caFile" (printf "%s/ca.crt" $dir) }}{{ end -}}
{{- $_ := set $c "login" (dict "type" "token" "tokenFile" (printf "%s/token" $dir)) -}}
{{- else -}}
{{- $_ := set $c "login" (omit $login "secretName") -}}
{{- end -}}
{{- end -}}
{{- with .istio }}{{ $_ := set $c "istio" . }}{{ end -}}
{{- with .clusterDomain }}{{ $_ := set $c "clusterDomain" . }}{{ end -}}
{{- with .prometheus }}{{ $_ := set $c "prometheus" (include "netatlas.prometheus" (dict "name" $c.name "prometheus" .) | fromYaml) }}{{ end -}}
{{- $clusters = append $clusters $c -}}
{{- end -}}
{{- toYaml (dict "clusters" $clusters) -}}
{{- end -}}

{{/*
A cluster's prometheus entry in the registry, from its values (`name` and `prometheus`). Only bearer
and basic auth read a Secret; auth none sends no credentials, so it takes no secretName.
*/}}
{{- define "netatlas.prometheus" -}}
{{- $name := .name -}}
{{- $values := .prometheus -}}
{{- if not $values.url -}}
{{- fail (printf "cluster %q sets prometheus, so it needs prometheus.url" $name) -}}
{{- end -}}
{{- /* A user or password in the address would be written into the ConfigMap and the release history; the message leaves the address out, as it holds the password. */ -}}
{{- if regexMatch "^[^:/?#]+://[^/?#]*@" (toString $values.url) -}}
{{- fail (printf "cluster %q prometheus.url must not carry a user or password: use prometheus.auth basic with a Secret" $name) -}}
{{- end -}}
{{- $type := include "netatlas.prometheusAuthType" $values -}}
{{- if not (has $type (list "none" "bearer" "basic")) -}}
{{- fail (printf "cluster %q prometheus.auth.type %q is not none, bearer or basic" $name $type) -}}
{{- end -}}
{{- $p := dict "url" $values.url -}}
{{- if ne $type "none" -}}
{{- if not $values.auth.secretName -}}
{{- fail (printf "cluster %q uses prometheus %s auth, so it needs prometheus.auth.secretName" $name $type) -}}
{{- end -}}
{{- $dir := include "netatlas.prometheusDir" $name -}}
{{- if eq $type "bearer" -}}
{{- $_ := set $p "auth" (dict "type" "bearer" "tokenFile" (printf "%s/token" $dir)) -}}
{{- else -}}
{{- $_ := set $p "auth" (dict "type" "basic" "usernameFile" (printf "%s/username" $dir) "passwordFile" (printf "%s/password" $dir)) -}}
{{- end -}}
{{- end -}}
{{- with $values.caData }}{{ $_ := set $p "caData" . }}{{ end -}}
{{- with $values.clusterLabel }}{{ $_ := set $p "clusterLabel" . }}{{ end -}}
{{- toYaml $p -}}
{{- end -}}

{{/* A prometheus entry's auth type; no auth means none. */}}
{{- define "netatlas.prometheusAuthType" -}}
{{- (.auth | default dict).type | default "none" | toString -}}
{{- end -}}

{{/*
A Secret volume's name, `<prefix>-<name>` from `prefix` and the cluster's `name`. Kubernetes takes a
volume name of at most 63 characters, so fail the render instead of installing a Deployment the API
server refuses. The message names both limits, since one cluster may mount both Secrets.
*/}}
{{- define "netatlas.secretVolume" -}}
{{- $volume := printf "%s-%s" .prefix .name -}}
{{- if gt (len $volume) 63 -}}
{{- fail (printf "cluster %q is too long to name its Secret volume: at most 52 characters with a Prometheus Secret, 55 with a token Secret" .name) -}}
{{- end -}}
{{- $volume -}}
{{- end -}}

{{/*
The Secrets mounted beside netatlas, each with its volume name and folder: a token cluster's, then
its Prometheus's when that uses bearer or basic auth.
*/}}
{{- define "netatlas.secretMounts" -}}
{{- $out := list -}}
{{- range .Values.clusters -}}
{{- $name := .name -}}
{{- $login := .login | default dict -}}
{{- if eq ($login.type | default "") "token" -}}
{{- $out = append $out (dict "volume" (include "netatlas.secretVolume" (dict "prefix" "cluster" "name" $name)) "dir" (include "netatlas.secretDir" $name) "secretName" $login.secretName) -}}
{{- end -}}
{{- with .prometheus -}}
{{- if has (include "netatlas.prometheusAuthType" .) (list "bearer" "basic") -}}
{{- $out = append $out (dict "volume" (include "netatlas.secretVolume" (dict "prefix" "prometheus" "name" $name)) "dir" (include "netatlas.prometheusDir" $name) "secretName" .auth.secretName) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- toJson $out -}}
{{- end -}}
