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

{{/*
The registry file netatlas reads (clusters.yaml). A token cluster reads the token and CA its Secret
holds, so its entry names files under the Secret's mount instead of a secretName. Fields left out of
the values stay out, so netatlas's own checks name what is missing.
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
{{- $clusters = append $clusters $c -}}
{{- end -}}
{{- toYaml (dict "clusters" $clusters) -}}
{{- end -}}

{{/* The clusters netatlas reads through a Secret mounted beside it. */}}
{{- define "netatlas.tokenClusters" -}}
{{- $out := list -}}
{{- range .Values.clusters -}}
{{- if eq ((.login | default dict).type | default "") "token" }}{{ $out = append $out . }}{{ end -}}
{{- end -}}
{{- toJson $out -}}
{{- end -}}
