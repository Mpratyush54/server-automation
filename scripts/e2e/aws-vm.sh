#!/usr/bin/env bash
# Ephemeral EC2 VM for the e2e suite (.github/workflows/e2e-vm.yml).
#
#   aws-vm.sh keys      generate the SSH client key and the VM's host key
#   aws-vm.sh launch    security group + instance (spot, on-demand fallback), wait for SSH
#   aws-vm.sh teardown  terminate this run's instance and delete its security group
#   aws-vm.sh janitor   terminate/delete everything tagged purpose=platform-e2e-ci that is too old
#
# Every resource is tagged purpose=platform-e2e-ci, run-id, profile, created-at
# and expires-at; the IAM role (scripts/e2e/aws-oidc-setup.sh) only allows
# terminating/deleting resources with that tag. The VM also powers itself off
# (and therefore terminates) after E2E_TTL_MINUTES, independent of CI.
#
# Environment:
#   AWS_REGION            region (required; credentials come from OIDC)
#   E2E_WORK              private work dir (keys, state)          [launch/teardown]
#   E2E_RUN_ID            unique run id, e.g. <run_id>-<attempt>  [launch/teardown]
#   E2E_PROFILE           minimal | full                          [launch/teardown]
#   E2E_INSTANCE_TYPE     default t3.xlarge
#   E2E_DISK_GB           default 100 (gp3)
#   E2E_SUBNET_ID         optional subnet (default: the default VPC's default subnets)
#   E2E_SPOT              true (default) tries spot first, then on-demand
#   E2E_TTL_MINUTES       VM self-destruct timer, default 150
#   E2E_MAX_AGE_MINUTES   janitor threshold, default 120 (hourly janitor => nothing lives 3 h)
#   E2E_DRY_RUN           janitor: list only
set -euo pipefail

PURPOSE="platform-e2e-ci"
AMI_PARAM="/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
need_aws() {
  : "${AWS_REGION:?AWS_REGION is required}"
  export AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
}

now_epoch() { date -u +%s; }
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
to_epoch() { date -u -d "$1" +%s 2>/dev/null || echo 0; }

tag_spec() { # tag_spec RESOURCE_TYPE -> JSON TagSpecifications entry
  local name="platform-e2e-${E2E_RUN_ID}-${E2E_PROFILE}"
  printf '{"ResourceType":"%s","Tags":[{"Key":"purpose","Value":"%s"},{"Key":"Name","Value":"%s"},{"Key":"run-id","Value":"%s"},{"Key":"profile","Value":"%s"},{"Key":"created-at","Value":"%s"},{"Key":"expires-at","Value":"%s"}]}' \
    "$1" "$PURPOSE" "$name" "$E2E_RUN_ID" "$E2E_PROFILE" "$CREATED_AT" "$EXPIRES_AT"
}

cmd_keys() {
  source "$(dirname "$0")/lib.sh"
  rm -f "$E2E_WORK/id_ed25519" "$E2E_WORK/id_ed25519.pub" "$E2E_WORK/host_ed25519" "$E2E_WORK/host_ed25519.pub"
  ssh-keygen -q -t ed25519 -N '' -C "platform-e2e-client" -f "$E2E_WORK/id_ed25519"
  # The host key is generated here and installed by cloud-init, so the first
  # connection is verified (StrictHostKeyChecking=yes) instead of trusted blindly.
  ssh-keygen -q -t ed25519 -N '' -C "platform-e2e-host" -f "$E2E_WORK/host_ed25519"
  printf '%s %s\n' "$E2E_HOST_ALIAS" "$(cut -d' ' -f1,2 "$E2E_WORK/host_ed25519.pub")" > "$E2E_WORK/known_hosts"
  if [[ ! -s "$E2E_WORK/admin-password" ]]; then
    (umask 077; openssl rand -hex 18 > "$E2E_WORK/admin-password")
  fi
  mask "$(cat "$E2E_WORK/admin-password")"
  log "ephemeral SSH keys and admin password generated"
}

user_data() { # cloud-config: authorised key, pinned host key, self-destruct timer
  local ttl="${E2E_TTL_MINUTES:-150}"
  cat <<EOF
#cloud-config
ssh_deletekeys: true
ssh_genkeytypes: []
ssh_keys:
  ed25519_private: |
$(sed 's/^/    /' "$E2E_WORK/host_ed25519")
  ed25519_public: $(cut -d' ' -f1,2 "$E2E_WORK/host_ed25519.pub")
ssh_authorized_keys:
  - $(cut -d' ' -f1,2 "$E2E_WORK/id_ed25519.pub")
package_update: false
package_upgrade: false
runcmd:
  # Last line of defence against leaked VMs: shutdown => terminate
  # (instance-initiated shutdown behaviour is "terminate").
  - [ shutdown, -P, "+${ttl}", "platform e2e TTL reached" ]
EOF
}

run_instance() { # run_instance spot|on-demand SG_ID SUBNET AMI
  local market=$1 sg=$2 subnet=$3 ami=$4 args
  # shellcheck disable=SC2054 # commas are part of single AWS CLI arguments (Key=a,Value=b)
  args=(ec2 run-instances --image-id "$ami" --instance-type "${E2E_INSTANCE_TYPE:-t3.xlarge}" --count 1
    --user-data "file://$E2E_WORK/user-data.yaml"
    --instance-initiated-shutdown-behavior terminate
    --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1
    --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":${E2E_DISK_GB:-100},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]"
    --tag-specifications "[$(tag_spec instance),$(tag_spec volume)]"
    --query 'Instances[0].InstanceId' --output text)
  if [[ -n "$subnet" ]]; then
    args+=(--network-interfaces "[{\"DeviceIndex\":0,\"SubnetId\":\"$subnet\",\"AssociatePublicIpAddress\":true,\"Groups\":[\"$sg\"],\"DeleteOnTermination\":true}]")
  else
    args+=(--security-group-ids "$sg")
  fi
  if [[ "$market" == spot ]]; then
    args+=(--instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time","InstanceInterruptionBehavior":"terminate"}}')
  fi
  aws "${args[@]}"
}

cmd_launch() {
  source "$(dirname "$0")/lib.sh"
  : "${E2E_RUN_ID:?}" "${E2E_PROFILE:?}"
  [[ "$E2E_RUN_ID" =~ ^[A-Za-z0-9-]+$ && "$E2E_PROFILE" =~ ^[a-z]+$ ]] || die "invalid run id or profile"
  [[ -s "$E2E_WORK/id_ed25519" ]] || die "run '$0 keys' first"
  local started name created ttl runner_ip ami vpc subnet sg iid market ip i
  started=$(now_epoch)
  ttl="${E2E_TTL_MINUTES:-150}"
  CREATED_AT=$(iso "$started")
  EXPIRES_AT=$(iso $((started + ttl * 60)))
  name="platform-e2e-${E2E_RUN_ID}-${E2E_PROFILE}"
  state_set REGION "$AWS_REGION"

  runner_ip=$(curl -fsS --retry 3 https://checkip.amazonaws.com | tr -d '[:space:]')
  [[ "$runner_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "could not determine the runner's public IPv4 address"
  mask "$runner_ip"

  ami=$(aws ssm get-parameter --name "$AMI_PARAM" --query Parameter.Value --output text)
  [[ "$ami" =~ ^ami-[0-9a-f]+$ ]] || die "could not resolve the Ubuntu 24.04 AMI"
  subnet="${E2E_SUBNET_ID:-}"
  if [[ -n "$subnet" ]]; then
    vpc=$(aws ec2 describe-subnets --subnet-ids "$subnet" --query 'Subnets[0].VpcId' --output text)
  else
    vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
  fi
  [[ "$vpc" =~ ^vpc-[0-9a-f]+$ ]] || die "no VPC found: create a default VPC or set E2E_SUBNET_ID"
  log "region $AWS_REGION, image $ami, type ${E2E_INSTANCE_TYPE:-t3.xlarge}"

  sg=$(aws ec2 create-security-group --group-name "$name" --description "platform e2e run $E2E_RUN_ID ($E2E_PROFILE)" \
    --vpc-id "$vpc" --tag-specifications "[$(tag_spec security-group)]" --query GroupId --output text)
  state_set SG_ID "$sg"
  aws ec2 authorize-security-group-ingress --group-id "$sg" --ip-permissions \
    "[{\"IpProtocol\":\"tcp\",\"FromPort\":22,\"ToPort\":22,\"IpRanges\":[{\"CidrIp\":\"$runner_ip/32\",\"Description\":\"SSH from this CI runner only\"}]},
      {\"IpProtocol\":\"tcp\",\"FromPort\":80,\"ToPort\":80,\"IpRanges\":[{\"CidrIp\":\"0.0.0.0/0\",\"Description\":\"HTTP (ACME, redirect)\"}]},
      {\"IpProtocol\":\"tcp\",\"FromPort\":443,\"ToPort\":443,\"IpRanges\":[{\"CidrIp\":\"0.0.0.0/0\",\"Description\":\"HTTPS\"}]}]" >/dev/null

  (umask 077; user_data > "$E2E_WORK/user-data.yaml")
  iid=""
  market=on-demand
  if [[ "${E2E_SPOT:-true}" == true ]]; then
    if iid=$(run_instance spot "$sg" "$subnet" "$ami" 2> "$E2E_WORK/spot-error.txt"); then
      market=spot
    else
      log "spot capacity unavailable ($(grep -o 'An error occurred ([A-Za-z]*)' "$E2E_WORK/spot-error.txt" | head -1)); falling back to on-demand"
      iid=""
    fi
  fi
  if [[ -z "$iid" ]]; then
    iid=$(run_instance on-demand "$sg" "$subnet" "$ami")
  fi
  [[ "$iid" =~ ^i-[0-9a-f]+$ ]] || die "run-instances returned no instance id"
  state_set INSTANCE_ID "$iid"
  state_set MARKET "$market"
  log "instance launched ($market); waiting for it to run"
  aws ec2 wait instance-running --instance-ids "$iid"
  ip=$(aws ec2 describe-instances --instance-ids "$iid" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "instance has no public IPv4 address (subnet must auto-assign one)"
  mask "$ip"
  state_set VM_IP "$ip"
  state_set DOMAIN "$ip.sslip.io"

  for i in $(seq 1 60); do
    if vm_ssh true 2>/dev/null; then break; fi
    [[ $i -lt 60 ]] || die "SSH did not come up within 5 minutes"
    sleep 5
  done
  # Provision installs packages: let cloud-init release the apt/dpkg locks first.
  vm_ssh 'cloud-init status --wait >/dev/null; rc=$?; [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]'
  phase launch ok $(( $(now_epoch) - started ))
  log "VM ready over SSH (host key verified)"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    { echo "instance_id=$iid"; echo "market=$market"; } >> "$GITHUB_OUTPUT"
  fi
}

# Instances and security groups of THIS run, from state and from tags (in case
# launch failed between creating a resource and recording it).
cmd_teardown() {
  source "$(dirname "$0")/lib.sh"
  : "${E2E_RUN_ID:?}" "${E2E_PROFILE:?}"
  local filters ids sgs sg ok=1 i
  # shellcheck disable=SC2054 # commas are part of single AWS CLI arguments (Key=a,Value=b)
  filters=(Name=tag:purpose,Values="$PURPOSE" Name=tag:run-id,Values="$E2E_RUN_ID" Name=tag:profile,Values="$E2E_PROFILE")
  ids=$( { state_get INSTANCE_ID; aws ec2 describe-instances --filters "${filters[@]}" \
      Name=instance-state-name,Values=pending,running,stopping,stopped \
      --query 'Reservations[].Instances[].InstanceId' --output text | tr '\t' '\n'; } | grep -E '^i-' | sort -u || true)
  if [[ -n "$ids" ]]; then
    # shellcheck disable=SC2086
    aws ec2 terminate-instances --instance-ids $ids >/dev/null || ok=0
    log "terminating $(wc -w <<<"$ids") instance(s)"
    # shellcheck disable=SC2086
    aws ec2 wait instance-terminated --instance-ids $ids || ok=0
  fi
  sgs=$( { state_get SG_ID; aws ec2 describe-security-groups --filters "${filters[@]}" \
      --query 'SecurityGroups[].GroupId' --output text | tr '\t' '\n'; } | grep -E '^sg-' | sort -u || true)
  for sg in $sgs; do
    # The group stays "in use" until the instance's network interface is gone.
    for i in $(seq 1 18); do
      if aws ec2 delete-security-group --group-id "$sg" 2>/dev/null; then break; fi
      if [[ $i -eq 18 ]]; then log "could not delete a security group yet; the janitor will retry"; ok=0; fi
      sleep 10
    done
  done
  if [[ $ok -ne 1 ]]; then log "teardown incomplete"; exit 1; fi
  log "teardown complete"
}

cmd_janitor() {
  local max now cutoff dry rc=0 id launch expires sg created
  max="${E2E_MAX_AGE_MINUTES:-120}"
  now=$(now_epoch)
  cutoff=$((now - max * 60))
  dry="${E2E_DRY_RUN:-false}"
  echo "janitor: max age ${max} min, region $AWS_REGION, dry-run=$dry"
  while read -r id launch expires; do
    [[ "$id" =~ ^i- ]] || continue
    if (( $(to_epoch "$launch") < cutoff )) || { [[ "$expires" != None ]] && (( $(to_epoch "$expires") < now )); }; then
      echo "terminate $id (launched $launch, expires $expires)"
      if [[ "$dry" != true ]]; then aws ec2 terminate-instances --instance-ids "$id" >/dev/null || rc=1; fi
    fi
  done < <(aws ec2 describe-instances --filters Name=tag:purpose,Values="$PURPOSE" \
      Name=instance-state-name,Values=pending,running,stopping,stopped \
      --query 'Reservations[].Instances[].[InstanceId,LaunchTime,Tags[?Key==`expires-at`]|[0].Value]' --output text)
  # Security groups have no creation time: use the created-at tag (missing => old).
  while read -r sg created; do
    [[ "$sg" =~ ^sg- ]] || continue
    if [[ "$created" == None ]] || (( $(to_epoch "$created") < cutoff )); then
      echo "delete security group $sg (created $created)"
      if [[ "$dry" != true ]]; then
        aws ec2 delete-security-group --group-id "$sg" 2>/dev/null || echo "  still in use; next run retries"
      fi
    fi
  done < <(aws ec2 describe-security-groups --filters Name=tag:purpose,Values="$PURPOSE" \
      --query 'SecurityGroups[].[GroupId,Tags[?Key==`created-at`]|[0].Value]' --output text)
  return $rc
}

case "${1:-}" in
  keys) cmd_keys ;;
  launch) need_aws; cmd_launch ;;
  teardown) need_aws; cmd_teardown ;;
  janitor) need_aws; cmd_janitor ;;
  *) echo "usage: $0 keys|launch|teardown|janitor" >&2; exit 2 ;;
esac
