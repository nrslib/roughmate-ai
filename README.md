# Roughmate AI

Slackの相談窓口をAWSまたはGoogle Cloudへセルフホストするアプリケーションです。相談を受けてAIが回答案を作り、対応チャンネルの人が採用・編集して元のスレッドへ返信します。登録窓口BotのHomeからチームごとのBotを追加でき、各Botが専用の設定・資料・LLM Wiki・回答集を持ちます。

このリポジトリは、AWS版とGoogle Cloud版を導入・運用するためのSource Availableスナップショットです。Google Cloudへの導入は [Google Cloudセルフホスティング](docs/google-cloud.md) を参照してください。以下はAWS版の手順です。ライセンスは [PolyForm Shield 1.0.0](LICENSE) です。利用・改変・配布の条件と競合製品に関する制限は全文を確認してください。

## 必要なもの

- Node.js `^22.13.0 || >=24.0.0` とnpm。Lambdaの実行環境はNode.js 22です。
- Terraform 1.10以上、2.0未満。AWS providerは同梱lockfileで固定します。
- Git、`zip`、bash、AWS CLI v2。AWSの商用リージョンで利用します。
- 対象AWSアカウントの管理者認証と、Slackワークスペースで専用アプリを作成・承認できる権限。
- Slack App configuration Access Token、子Bot登録接続用のConfiguration Refresh Token。
- OpenAI APIキーと、そのアカウントで利用可能なモデルID。モデルは導入時に明示入力します。

AWS認証は標準credential chain（`AWS_PROFILE`、SSO、環境変数等）を使用します。SDK・AWS CLI・Terraformに同じ認証を使ってください。秘密値は対話の非表示入力からAWS Secrets Managerへ保存し、引数・JSONサンプル・Terraform変数へ記入しません。

## 導入

以下のアカウントID `123456789012`、環境名 `dev`、プロファイル名は架空の例です。自分の対象へ置き換えてください。

```bash
git clone https://github.com/nrslib/roughmate-ai.git
cd roughmate-ai
npm ci
npm run typecheck
npm run lint
npm run build
./scripts/show-config --help
```

`dist/roughmate.zip` がLambdaの成果物です。`--help`はAWS・Slack操作を開始しません。初回導入では、先に管理者が環境用のIAM permissions boundaryを5本作成します（http、worker、provisioner、scheduler、wiki-runner）。手順と通常運用の権限分離は [IAMの準備](docs/iam.md) を参照してください。境界を準備せずにinstallだけを実行しても導入できません。

```bash
export AWS_PROFILE=roughmate-admin
aws sts get-caller-identity
node --import tsx scripts/iam-policies.ts \
  --account 123456789012 --region ap-northeast-1 --env dev \
  --boundaries-only --out .roughmate/iam-boundaries
```

[IAMの準備](docs/iam.md) に従って生成した5本をAWSへ作成した後、共有stateバケットを準備し、専用の登録窓口Botを導入します。

```bash
./scripts/bootstrap-state --region ap-northeast-1 --env dev
./scripts/install --region ap-northeast-1 --env dev \
  --name 'チーム Roughmate' --description 'チームの相談窓口' \
  --preserve-purge-evidence
```

`bootstrap-state`はaccount/regionごとの共有バケットを作成し、専用タグ・公開アクセス拒否・暗号化・versioningを設定します。全環境に影響する管理者専用の準備です。通常の導入・更新は既存バケットを検証し、設定を変更しません。環境分離には `--env` を使い、Terraform workspaceはdefaultのままにします。

`install`はビルド、Terraform適用、Slackアプリ作成・Manifest設定、秘密保存を行います。Terraformの変更内容を確認して適用してください。Slack構成Access Token、OpenAI APIキー、モデルIDを入力し、最後に表示するURLをブラウザで開いてOAuthを承認します。初回承認者が管理者、承認先が対象ワークスペースになります。認可URLは15分・一回限りです。

`--preserve-purge-evidence`は新規の未使用環境に完全削除用のRoot履歴を開始します。この方式ではRoot Appの作成・再作成に管理者認証が必要です。過去の履歴がない既存環境へ後付けして完全な履歴とすることはできません。通常の導入・削除には省略できますが、その環境の完全削除が可能とは保証しません。

導入後、Terraform出力の実API IDとjobsのevent source mapping IDを使い、[IAMの準備](docs/iam.md) の手順で通常運用policyを生成・設定します。

## Botの接続・設定

RootのOAuth完了後、環境管理者が初回承認者のConfiguration Refresh Tokenを非表示入力して、登録機能を接続します。

```bash
AWS_PROFILE=roughmate-admin ./scripts/connect-registration \
  --region ap-northeast-1 --env dev
```

接続後は登録窓口のHomeで「新しいRoughmateを作る」を選び、名前・メンション名・所属説明を入力します。「Slackに追加」から各BotのOAuthを承認し、登録一覧で「利用可能」を確認してください。

各BotのHomeで管理者・相談受付チャンネル・対応チャンネル・任意通知先を保存します。新規Botは受付を停止しており、受付先と対応先の設定後に利用を開始します。公開チャンネルにはBotが自動参加します。非公開先は、保存する本人がHomeの「非公開招待を本人認可」で認可してから保存してください。外部共有・アーカイブ済みのチャンネルは使えません。

相談受付チャンネルでBotをメンションすると、対応チャンネルへ回答案を表示します。人が採用または編集して返信します。送信結果が不明なら「送信結果を再照合」で保存状態と元スレッドを確認してください。

## 資料・Wiki・設定の管理

BotのHomeから手入力資料・公開HTTPSの単一ページを追加し、閲覧を許可する受付先・対応先を選びます。資料は最大12件、各原文64KiBまでです。「今すぐ同期」で整理を再開し、「Wikiを開く」からSlack本人認証付きのブラウザWikiを閲覧できます。本人の現在の所属と出典の公開範囲を確認して表示します。

回答送信後、Wiki更新方針を非同期に提案します。Bot管理者が採用・編集採用した方針をAIが最新Wikiへ反映します。回答の送信とWiki方針の採用は別操作です。回答集には送信済みの質問・最終回答・根拠を保持します。

Rootの設定表示・資料管理にはCLIも使えます。`--actor`には対象Botの管理者SlackユーザーIDを指定します。以下の `SLACK_USER_ID` はプレースホルダーです。

```bash
./scripts/show-config --region ap-northeast-1 --env dev --actor SLACK_USER_ID
./scripts/configure --region ap-northeast-1 --env dev --actor SLACK_USER_ID \
  --name 'チーム Roughmate' --description 'チームの相談窓口'
./scripts/knowledge-put --region ap-northeast-1 --env dev --actor SLACK_USER_ID \
  --file examples-knowledge.json
./scripts/knowledge-list --region ap-northeast-1 --env dev --actor SLACK_USER_ID
./scripts/knowledge-delete --region ap-northeast-1 --env dev --actor SLACK_USER_ID \
  --id expense-faq
```

サンプル資料の公開先は空です。受付・対応先・通知はCLIではなくSlack Homeから設定してください。名前・説明・管理者は `configure --file` のJSONでも変更できます。

## 復旧と更新

別端末でも同じソース・AWS認証・account/region/envを使って操作できます。状態は共有S3バケット、アプリ設定はDynamoDB、秘密はSecrets Managerに保存します。更新は最新スナップショットで `npm ci`、`npm run build`、`./scripts/deploy-aws --region REGION --env ENV` を実行し、IAMの必要変更も管理者が確認してください。

認証・権限・通信・保存の結果が不明なら、再作成せず保存状態とSlack管理画面を照合します。Rootの作成結果不明は `setup-slack --recover-app-id`、子の作成結果不明は `recover-registration --id --recover-app-id` を使用します。OAuthの成否不明では同じcodeを再交換しません。子の未保存結果の復旧には管理者による `--restart-oauth`、確定した失敗の再開には `--resume-failed` があります。詳細な引数は各CLIの `--help` で確認してください。

Configuration token更新の成否不明では古いRefresh Tokenを再利用せず、所有者が新しく発行し `connect-registration --reconnect` で明示再接続します。余剰Slack scopeは同じAppの再OAuthで縮小できないため、対象専用Appの削除・再作成が必要です。CloudWatchの失敗コード、DLQ、現在の保存状態を照合して復旧してください。相談・資料・キューには業務データが含まれます。

## Bot削除・アンインストール

登録窓口または子BotのHomeで「Botを削除」を選び、登録窓口のowner本人が対象Appを確認します。利用可能Botでは現在のBot管理者権限も必要です。相談・送信・Wiki編集を停止し、Slack Appの不存在確認後に登録をアーカイブへ移します。AWSの専用table・秘密・Wiki・回答集は保持し、Botアーカイブから制限付きで閲覧できます。

通常の環境アンインストールは専用Slack Appを削除し、続いてTerraform資源を削除します。子Bot・未完了登録が残る場合は停止します。結果不明の登録を未作成と推測して除去しないでください。環境全体の廃止には次項の完全削除を使用できます。

```bash
./scripts/uninstall --region ap-northeast-1 --env dev
# 個別の入口
./scripts/remove-slack --region ap-northeast-1 --env dev
./scripts/destroy-aws --region ap-northeast-1 --env dev
```

共有stateバケット、当該環境のstate履歴・削除記録、他環境、Slackチャンネル・投稿済みメッセージは保持します。通常uninstallの後に完全削除を行う予定なら、管理者認証で `uninstall --preserve-purge-evidence` を指定し、削除前に所有証跡を保存してください。

## 環境の完全削除

`purge-env`は全Root世代・子Bot・アーカイブ・専用AWS資源・秘密の全世代・当該環境のS3管理履歴を対象にする不可逆の削除です。管理者AWS認証、完全なRoot履歴と所有証明が必要です。通常の限定運用roleでは実行できません。現在の生成policyが保護領域への書込を許していないことを [IAMの準備](docs/iam.md) に従って確認してください。

```bash
export AWS_PROFILE=roughmate-admin
npm run build
./scripts/purge-env --account 123456789012 --region ap-northeast-1 --env dev --dry-run
./scripts/purge-env --account 123456789012 --region ap-northeast-1 --env dev
```

最初のコマンドは所有境界・保持状況を調査し、停止・削除を開始しません。実削除では対象を再入力し、計画を保存して実行します。失敗時は計画を保持し、同じコマンドで再開します。対象を変更する他のCLI・AWS/Slack管理画面・Terraform操作を終了してから実行してください。未知App・履歴不足・未知資源・共有IAM・別workspace・保持バックアップでは停止します。

共有stateバケット、別環境、Slack投稿、外部コピー、CloudTrail等の監査ログ、AWS/Slack内部保持は対象外です。PITR・SYSTEM/AWS Backupの保持データが残る場合は完了せず、管理者の整理・保持期間満了を必要とします。S3 Object Lock等の保持でも削除できるとは保証しません。

## 配布内容

アプリ・CLI・ビルド・AWS/Google Cloud Terraform・Slack Manifest・AWS IAM generatorと利用者向け資料を含みます。テストと内部検証資料は配布対象外です。`.source-snapshot.json` は元ソースcommit、許可リストhash、配布ファイルhashを記録します。AWS版とGoogle Cloud版の両方を配布します。
