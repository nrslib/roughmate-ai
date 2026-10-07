# AWS IAMの準備

初回の管理者準備と、環境専用の通常運用を分けます。以下の `123456789012`、`dev`、プロファイル名は架空の例です。AWSアカウント・リージョン・環境名はすべて同じ対象に合わせてください。IAM generatorはAWSへアクセスせずJSONだけを作成します。生成内容を確認してから管理者が適用します。

## 初回: 5本のpermissions boundary

Terraformが参照するboundaryは次の5本です。Terraformはboundary自体を作成しません。

- `roughmate-dev-ap-northeast-1-http-boundary`
- `roughmate-dev-ap-northeast-1-worker-boundary`
- `roughmate-dev-ap-northeast-1-provisioner-boundary`
- `roughmate-dev-ap-northeast-1-scheduler-boundary`
- `roughmate-dev-ap-northeast-1-wiki-runner-boundary`

```bash
(
  set -eu
  export AWS_PROFILE=roughmate-admin
  aws sts get-caller-identity
  mkdir -p .roughmate
  roughmate_boundary_dir=$(mktemp -d .roughmate/iam-boundaries.XXXXXX)
  node --import tsx scripts/iam-policies.ts \
    --account 123456789012 --region ap-northeast-1 --env dev \
    --boundaries-only --out "$roughmate_boundary_dir"

  for kind in http worker provisioner scheduler wiki-runner; do
    policy_name="roughmate-dev-ap-northeast-1-${kind}-boundary"
    aws iam create-policy --policy-name "$policy_name" \
      --policy-document "file://${roughmate_boundary_dir}/${policy_name}.json"
  done
)
```

括弧内だけで失敗時に停止するため、対話shellの設定や認証profileを変更しません。毎回新しいディレクトリへ生成し、生成失敗時は以前のJSONを使いません。policy作成が途中で失敗した場合も後続を実行しません。作成済みのpolicyは自動で取り消さないため、AWS上の状態を確認してください。このcreateコマンドは新規policy用です。既存policyは下記のversion更新を使用してください。boundaryは対象Lambda・Scheduler実行roleの最大権限で、Terraformが作るinline policyと併せて評価されます。http/workerの子Botデータ参照、provisionerの作成・秘密操作、schedulerの配送、wiki-runnerの限定キー操作を維持してください。

続いてREADMEの `bootstrap-state` と `install` を管理者認証で実行します。state専用の権限を確認する場合は、次の生成モードもあります。

```bash
node --import tsx scripts/iam-policies.ts \
  --account 123456789012 --region ap-northeast-1 --env dev \
  --bootstrap-only --out .roughmate/iam-bootstrap
```

`RoughmateStateBootstrapAccess`は共有stateバケットの初回作成・保護設定用です。通常運用roleにバケット設定変更を付ける必要はありません。

## 導入後: 実IDへ制限した運用policy

初回の管理者導入後、対象HTTP API IDとjobs queueからworkerへ接続するmapping UUIDを照合します。以下は読み取り用のコマンドです。

```bash
aws apigatewayv2 get-apis --region ap-northeast-1 \
  --query "Items[?Name=='roughmate-dev'].{ApiId:ApiId,Name:Name,Tags:Tags}"
aws lambda list-event-source-mappings --region ap-northeast-1 \
  --function-name roughmate-dev-worker \
  --query 'EventSourceMappings[].{UUID:UUID,Source:EventSourceArn,Function:FunctionArn}'
```

API名と `Application=roughmate-self-hosted`、`Environment=dev` タグ、mappingの関数と `roughmate-dev-jobs` queueのARNを確認してください。次の変数へ実際のIDを入力してJSONを生成します。

```bash
printf '%s' '対象HTTP API ID: '
read -r roughmate_api_id
printf '%s' '対象jobs mapping UUID: '
read -r roughmate_mapping_id
node --import tsx scripts/iam-policies.ts \
  --account 123456789012 --region ap-northeast-1 --env dev \
  --api-id "$roughmate_api_id" --mapping-id "$roughmate_mapping_id" \
  --out .roughmate/iam-runtime
```

全生成モードでは5本のboundaryと次の5本を生成します。

| 生成policy | 用途 |
| --- | --- |
| `RoughmateDeploymentAccess` | 固定環境のTerraform資源更新・削除 |
| `RoughmateSetupAccess` | state・設定・Root資料・接続先検証 |
| `RoughmateRegistrationSetupAccess` | Configuration tokenの初回接続・管理者復旧 |
| `RoughmateRegistrationDeploymentAccess` | provisioner・scheduler・登録用queue等の配備 |
| `RoughmateWikiDeploymentAccess` | Wiki専用worker・queue・mapping等の配備 |

managed policyはアカウント単位です。複数環境では汎用生成名をそのまま共用せず、例 `roughmate-dev-ap-northeast-1-SetupAccess` のように環境別のAWS policy名を付けます。ただし、独自名は完全削除時の固定5policy名の自動保護検査に含まれません。独自名を使用する運用者は、保護領域への書込・削除を許していないことを別途確認する必要があります。Terraformの通常更新にはDeployment、RegistrationDeployment、WikiDeployment、Setupの各権限が必要です。初回登録接続・子の管理者復旧にRegistrationSetupを追加します。通常利用者にはAWS管理権限を渡しません。

例として新規の環境専用Setup policyを作成できます。

```bash
aws iam create-policy \
  --policy-name roughmate-dev-ap-northeast-1-SetupAccess \
  --policy-document file://.roughmate/iam-runtime/RoughmateSetupAccess.json
```

同じ方式で必要なpolicyを作り、既存の環境運用roleへ管理者が付与します。対象roleの信頼policy、実際の付与権限、session policy、組織側制限も確認してください。generatorはprincipalを自動作成・変更しません。API/mappingを作り直した場合は実IDを再照合して再生成します。

## 既存policyの更新

まず更新対象のdefault versionのDocumentを取得し、生成JSONと比較します。[get-policy](https://docs.aws.amazon.com/cli/latest/reference/iam/get-policy.html) の `DefaultVersionId` と [get-policy-version](https://docs.aws.amazon.com/cli/latest/reference/iam/get-policy-version.html) の `Document` を使用します。AWS CLIのJSON出力を既存のNodeで整形して比較します。以下は取得・比較だけで、AWSの権限を変更しません。

```bash
printf '%s' '更新対象policy ARN: '
read -r roughmate_policy_arn
(
  set -eu
  test -n "$roughmate_policy_arn"
  mkdir -p .roughmate
  roughmate_review_dir=$(mktemp -d .roughmate/iam-review.XXXXXX)
  roughmate_default_version=$(aws iam get-policy --policy-arn "$roughmate_policy_arn" \
    --query Policy.DefaultVersionId --output text --no-cli-pager)
  aws iam get-policy-version --policy-arn "$roughmate_policy_arn" \
    --version-id "$roughmate_default_version" --query PolicyVersion.Document \
    --output json --no-cli-pager > "$roughmate_review_dir/current.json"
  node --input-type=module - "$roughmate_review_dir" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const directory = process.argv[2];
for (const [input, output] of [
  [`${directory}/current.json`, `${directory}/current.formatted.json`],
  ['.roughmate/iam-runtime/RoughmateSetupAccess.json', `${directory}/proposed.formatted.json`],
]) {
  const document = JSON.parse(readFileSync(input, 'utf8'));
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('policy DocumentはJSON objectである必要があります');
  writeFileSync(output, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
}
JS
  if diff -u "$roughmate_review_dir/current.formatted.json" "$roughmate_review_dir/proposed.formatted.json"; then
    printf '%s\n' 'Documentに差分はありません'
  else
    roughmate_diff_status=$?
    test "$roughmate_diff_status" -eq 1
  fi
)
```

取得・JSON解析・比較に失敗した場合は停止します。`diff` の差分あり（終了値1）は正常な比較結果です。表示されたAction・Resource・Condition等を確認し、同じARNと生成JSONを更新対象とすることを確認してから、次の別手順でdefaultを切り替えます。比較後に生成JSONを変更した場合は比較をやり直してください。これは権限を変更する管理者操作です。

```bash
(
  set -eu
  test -n "${roughmate_policy_arn:?先に取得・比較する手順を完了してください}"
  aws iam list-policy-versions --policy-arn "$roughmate_policy_arn"
  aws iam create-policy-version --policy-arn "$roughmate_policy_arn" \
    --policy-document file://.roughmate/iam-runtime/RoughmateSetupAccess.json \
    --set-as-default
)
```

managed policyは最大5versionです。上限なら対象ARNと非defaultの旧versionを照合してから、管理者が不要versionだけを削除します。default versionは削除しません。boundary更新では対応するboundary JSONを指定します。共有利用のあるpolicyへ別環境のJSONを上書きしないでください。

## 完全削除の権限と保護領域

`purge-env`と `--preserve-purge-evidence` の操作は、permissions boundaryのない管理者IAM user/roleで、全Action/Resourceの無条件管理者許可とIAM simulationを照合します。通常運用roleは使いません。IAM simulationだけでSCP/RCP・session policy・実操作の成功を保証するものではありません。

最新generatorの通常Setup書込先は、その環境の `setup.json`、`removal.json`、`operation.json`、`terraform.tfstate`、`terraform.tfstate.tflock` だけです。管理者用の `environments/<env>/protected-purge/` に通常policyが書込・削除できないことを確認してください。Root履歴、全App台帳、所有証跡、計画・再開anchorはこの保護領域へ保存します。独自policy・bucket policyでも通常principalへ書込を与えないでください。

旧Setup policyが環境prefix全体への書込を許す場合は、管理者が最新生成JSONへ更新します。自動保護検査の対象は、表に示した固定5policy名を持ち、attachmentまたはpermissions boundaryで使用中のmanaged policyのdefault versionです。環境別の独自名、別のmanaged/inline policy、bucket policy、他principalの権限まで自動検査するものではありません。固定5名の検査が通っても保護領域全体のアクセス制御を保証しないため、管理者が独自に付与した権限も確認してください。通常の資料・設定管理に全table Scanや保護領域への書込を追加する必要はありません。
