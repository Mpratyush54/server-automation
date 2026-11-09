#!/usr/bin/env bash
# One-time AWS setup for the e2e VM workflows (run by a human with IAM admin
# rights in the AWS account that should host the ephemeral VMs).
#
# Creates (idempotently):
#   * the GitHub Actions OIDC identity provider, if the account has none;
#   * an IAM role trusted ONLY by this repository's GitHub environment
#     (token sub "repo:<owner>/<repo>:environment:<env>", audience sts.amazonaws.com),
#     max session 2 h, with an inline least-privilege policy:
#       - EC2 run/terminate limited to resources tagged purpose=platform-e2e-ci,
#         allowed instance types, volumes up to 200 GB, one region;
#       - security groups: create (tagged), add ingress / delete (tagged only);
#       - read-only Describe calls in that region, the public Ubuntu AMI parameter;
#   * the EC2 Spot service-linked role (needed once per account for spot).
# No access keys are created. Nothing else in the account is touched.
#
# Usage:
#   scripts/e2e/aws-oidc-setup.sh --region <region> [--repo owner/name] [--environment e2e-aws]
#                                 [--role-name platform-e2e-ci] [--instance-types t3.xlarge,t3a.xlarge]
#                                 [--dry-run]
# --dry-run prints the trust and permission policies without calling AWS.
set -euo pipefail

region=""
repo="Mpratyush54/server-automation"
environment="e2e-aws"
role="platform-e2e-ci"
types="t3.xlarge,t3a.xlarge"
dry=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) region="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --environment) environment="$2"; shift 2 ;;
    --role-name) role="$2"; shift 2 ;;
    --instance-types) types="$2"; shift 2 ;;
    --dry-run) dry=true; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || { echo "--region is required (e.g. eu-central-1)" >&2; exit 2; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "invalid --repo" >&2; exit 2; }
[[ "$environment" =~ ^[A-Za-z0-9_.-]+$ && "$role" =~ ^[A-Za-z0-9+=,.@_-]+$ ]] || { echo "invalid --environment or --role-name" >&2; exit 2; }
[[ "$types" =~ ^[a-z0-9.]+(,[a-z0-9.]+)*$ ]] || { echo "invalid --instance-types" >&2; exit 2; }

export AWS_PAGER=""
if [[ "$dry" == true ]]; then
  account="ACCOUNT_ID"
else
  account=$(aws sts get-caller-identity --query Account --output text)
fi
provider="arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com"
types_json=$(printf '"%s",' ${types//,/ }); types_json="[${types_json%,}]"
tag_cond='"StringEquals": {"aws:RequestTag/purpose": "platform-e2e-ci"}'
res_cond='"StringEquals": {"aws:ResourceTag/purpose": "platform-e2e-ci"}'
ec2="arn:aws:ec2:${region}:${account}"

trust=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "GitHubEnvironmentOnly",
    "Effect": "Allow",
    "Principal": {"Federated": "${provider}"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:${repo}:environment:${environment}"
      }
    }
  }]
}
EOF
)

policy=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DescribeInRegion",
      "Effect": "Allow",
      "Action": ["ec2:DescribeInstances", "ec2:DescribeInstanceStatus", "ec2:DescribeSecurityGroups",
                 "ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeImages", "ec2:DescribeTags"],
      "Resource": "*",
      "Condition": {"StringEquals": {"aws:RequestedRegion": "${region}"}}
    },
    {
      "Sid": "UbuntuAmiParameter",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:${region}::parameter/aws/service/canonical/ubuntu/server/24.04/stable/*"
    },
    {
      "Sid": "CreateSecurityGroupInVpc",
      "Effect": "Allow",
      "Action": "ec2:CreateSecurityGroup",
      "Resource": "${ec2}:vpc/*"
    },
    {
      "Sid": "CreateTaggedSecurityGroup",
      "Effect": "Allow",
      "Action": "ec2:CreateSecurityGroup",
      "Resource": "${ec2}:security-group/*",
      "Condition": {${tag_cond}}
    },
    {
      "Sid": "ManageTaggedSecurityGroups",
      "Effect": "Allow",
      "Action": ["ec2:AuthorizeSecurityGroupIngress", "ec2:DeleteSecurityGroup"],
      "Resource": "${ec2}:security-group/*",
      "Condition": {${res_cond}}
    },
    {
      "Sid": "NewIngressRules",
      "Effect": "Allow",
      "Action": "ec2:AuthorizeSecurityGroupIngress",
      "Resource": "${ec2}:security-group-rule/*"
    },
    {
      "Sid": "RunInstancesSupportingResources",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": ["arn:aws:ec2:${region}::image/*", "${ec2}:subnet/*", "${ec2}:network-interface/*",
                   "${ec2}:spot-instances-request/*"]
    },
    {
      "Sid": "RunInstancesTaggedSecurityGroup",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": "${ec2}:security-group/*",
      "Condition": {${res_cond}}
    },
    {
      "Sid": "RunTaggedInstancesOfAllowedTypes",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": "${ec2}:instance/*",
      "Condition": {"StringEquals": {"aws:RequestTag/purpose": "platform-e2e-ci", "ec2:InstanceType": ${types_json}}}
    },
    {
      "Sid": "RunTaggedVolumesUpTo200GB",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": "${ec2}:volume/*",
      "Condition": {${tag_cond}, "NumericLessThanEquals": {"ec2:VolumeSize": "200"}}
    },
    {
      "Sid": "TagOnlyOnCreate",
      "Effect": "Allow",
      "Action": "ec2:CreateTags",
      "Resource": ["${ec2}:instance/*", "${ec2}:volume/*", "${ec2}:security-group/*"],
      "Condition": {"StringEquals": {"ec2:CreateAction": ["RunInstances", "CreateSecurityGroup"]}}
    },
    {
      "Sid": "TerminateTaggedInstances",
      "Effect": "Allow",
      "Action": "ec2:TerminateInstances",
      "Resource": "${ec2}:instance/*",
      "Condition": {${res_cond}}
    }
  ]
}
EOF
)

if [[ "$dry" == true ]]; then
  echo "# Trust policy for role ${role}"; echo "$trust"
  echo "# Inline permission policy platform-e2e-ci"; echo "$policy"
  exit 0
fi

if ! aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text | tr '\t' '\n' | grep -qx "$provider"; then
  echo "creating the GitHub Actions OIDC provider"
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com >/dev/null
fi

if aws iam get-role --role-name "$role" >/dev/null 2>&1; then
  echo "updating role $role"
  aws iam update-assume-role-policy --role-name "$role" --policy-document "$trust"
  aws iam update-role --role-name "$role" --max-session-duration 7200
else
  echo "creating role $role"
  aws iam create-role --role-name "$role" --assume-role-policy-document "$trust" --max-session-duration 7200 \
    --description "GitHub Actions e2e VM suite (${repo}, environment ${environment})" \
    --tags Key=purpose,Value=platform-e2e-ci >/dev/null
fi
aws iam put-role-policy --role-name "$role" --policy-name platform-e2e-ci --policy-document "$policy"

if ! aws iam get-role --role-name AWSServiceRoleForEC2Spot >/dev/null 2>&1; then
  echo "creating the EC2 Spot service-linked role"
  aws iam create-service-linked-role --aws-service-name spot.amazonaws.com >/dev/null || true
fi

arn=$(aws iam get-role --role-name "$role" --query Role.Arn --output text)
cat <<EOF

Done. Now configure the repository (Settings -> Secrets and variables -> Actions -> Variables):

  gh variable set E2E_AWS_ROLE_ARN --repo ${repo} --body '${arn}'
  gh variable set E2E_AWS_REGION   --repo ${repo} --body '${region}'

and create the environment "${environment}" (Settings -> Environments) with
deployment branches and tags limited to: master, v* (tags), plus any branch
you want to validate with workflow_dispatch. See docs/operations/e2e-ci.md.
EOF
