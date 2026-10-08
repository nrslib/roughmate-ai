# Google Cloudセルフホスティング

Slackの相談、採用・編集・返信、子Bot登録、資料、Wiki、確定回答、ブラウザ本人認証はAWS版と共通です。実行基盤をCloud Run、Firestore Standard、Cloud Tasks、Secret Manager、Cloud Schedulerへ置き換えます。GCP用CLIの資料管理コマンドと完全purgeは未対応です。Botの設定・資料管理はSlack Homeから行います。

## 準備と導入

Node.js 22.13以上、npm、Terraform 1.10以上2未満、Google Cloud CLI、bashが必要です。Google providerはlockfileで固定します。DockerビルドはCloud Buildで実行し、ローカルDocker daemonは不要です。課金を有効にした専用プロジェクトへ、対象資源作成・IAM変更・API有効化・build service accountの利用ができる本人管理者でログインしてください。CLIとTerraformは本人のADCを使い、サービスアカウントの鍵は作りません。

以下の `YOUR_PROJECT`、`YOUR_STATE_BUCKET` は自分の対象へ置き換えます。環境名は小文字英字で始まる英数字・ハイフンの10文字以内です。子secretのIAM prefixと別環境が重ならないよう、予約文字列`-bot`を含む環境名は拒否します。同じプロジェクト・環境名は他の導入と共有しないでください。

### 導入者本人の権限

次はCLI/Terraformを実行する本人の権限です。実行SAへ付ける権限とは別です。専用projectの既存Ownerで導入する場合、新しいユーザーやSA鍵は不要です。Owner以外へ委任する場合は管理者が次の操作・対象を確認してください。既定ロールは必要操作を満たす構成例で、余分な権限も含みます。この組合せでの最小権限導入は実機検証していません。さらに絞る場合は公式の各権限表とTerraform planからcustom roleを作り、読取・更新・削除を含めて検証します。

| 操作 | 必要な権限・対象 | 対応する既定ロール例 |
| --- | --- | --- |
| project確認・API有効化 | 対象projectの`resourcemanager.projects.get`、`serviceusage.services.get/list/enable/use` | [Service Usage Admin](https://docs.cloud.google.com/iam/docs/roles-permissions/serviceusage) `roles/serviceusage.serviceUsageAdmin`とproject読取。ADCのquota projectにも`serviceusage.services.use`が必要 |
| state/build source bucketとstate操作 | 作成先projectの`storage.buckets.create`、専用bucketの`storage.buckets.get/update/delete/getIamPolicy/setIamPolicy`、`storage.objects.create/get/list/update/delete`。stateのlock作成・解除にもobject権限を使用 | [Storage Admin](https://docs.cloud.google.com/storage/docs/access-control/iam-roles) `roles/storage.admin`。作成後のobject操作は専用bucketへ限定可能 |
| project IAM・custom role | 対象projectの`resourcemanager.projects.getIamPolicy/setIamPolicy`、`iam.roles.create/get/list/update/delete` | [Project IAM Admin](https://docs.cloud.google.com/resource-manager/docs/access-control-proj) `roles/resourcemanager.projectIamAdmin`と[Role Administrator](https://docs.cloud.google.com/iam/docs/roles-permissions/iam) `roles/iam.roleAdmin` |
| 環境SAの作成とIAM | 対象projectの`iam.serviceAccounts.create/list`、環境の4 SAの`iam.serviceAccounts.get/update/delete/getIamPolicy/setIamPolicy` | [Service Account Admin](https://docs.cloud.google.com/iam/docs/roles-permissions/iam) `roles/iam.serviceAccountAdmin` |
| SAをRun/Tasks/Scheduler/Buildへ指定 | 対象のruntime/tasks/scheduler/build SAそれぞれの`iam.serviceAccounts.actAs` | [Service Account User](https://docs.cloud.google.com/iam/docs/service-account-permissions) `roles/iam.serviceAccountUser`を対象SA単位に付与。本人へのToken Creatorや鍵作成権限は不要 |
| named Firestore DB・field設定・CLI状態操作 | 作成先projectの`datastore.databases.create`、対象DBの`datastore.databases.getMetadata/update`、`datastore.indexes.create/get/list/update/delete`、CLIが読む/保存する`datastore.entities.get/list/create/update/delete`とtransactionの`datastore.databases.get` | [Cloud Datastore Owner](https://firebase.google.com/docs/firestore/manage-databases) `roles/datastore.owner`。DBは通常destroyで保持する設計 |
| Root Secret資源と本人CLIの秘密操作 | 対象projectの`secretmanager.secrets.create`、対象Root Secretの`secretmanager.secrets.get/update/delete`と`secretmanager.versions.add/access/list` | [Secret Manager Admin](https://docs.cloud.google.com/iam/docs/roles-permissions/secretmanager) `roles/secretmanager.admin`。custom roleで資源管理と秘密読取を分離する場合、CLIの版読取・追加も残す |
| Cloud Run資源・公開/private IAM | 対象projectの`run.services.create`、環境HTTP/workerの`run.services.get/list/update/delete/getIamPolicy/setIamPolicy`、`run.operations.get` | [Cloud Run Admin](https://docs.cloud.google.com/run/docs/reference/iam/roles) `roles/run.admin`と上記runtime SAのactAs |
| 3 Tasks queueとIAM | 対象locationの`cloudtasks.queues.create`、環境queueの`cloudtasks.queues.get/list/update/delete/getIamPolicy/setIamPolicy` | [Cloud Tasks Admin](https://docs.cloud.google.com/iam/docs/roles-permissions/cloudtasks) `roles/cloudtasks.admin` |
| Scheduler job | 対象locationの`cloudscheduler.jobs.create`、環境jobの`cloudscheduler.jobs.get/list/update/delete` | [Cloud Scheduler Admin](https://docs.cloud.google.com/iam/docs/roles-permissions/cloudscheduler) `roles/cloudscheduler.admin`と上記scheduler SAのactAs |
| Artifact Registry資源/IAM・image digest読取 | 対象projectの`artifactregistry.repositories.create`、環境repoの`artifactregistry.repositories.get/list/update/delete/getIamPolicy/setIamPolicy`、`artifactregistry.dockerimages.get/list` | [Artifact Registry Administrator](https://docs.cloud.google.com/iam/docs/roles-permissions/artifactregistry) `roles/artifactregistry.admin`。image pushは専用build SAへ付与する |
| Cloud Build submit・状態取得 | 対象projectの`cloudbuild.builds.create/get/list`、`cloudbuild.operations.get`、専用build SAのactAs、build source bucketへのupload、build log読取 | [Cloud Build Editor](https://docs.cloud.google.com/iam/docs/roles-permissions/cloudbuild) `roles/cloudbuild.builds.editor`、上記Storage/SA User、[Logs Viewer](https://docs.cloud.google.com/iam/docs/roles-permissions/logging) `roles/logging.viewer` |
| 対象HTTP request logのexclusion | 対象projectの`logging.exclusions.create/get/list/update/delete` | [Logs Configuration Writer](https://docs.cloud.google.com/iam/docs/roles-permissions/logging) `roles/logging.configWriter` |

project IAM変更を持つ導入者は他の権限も付与できます。本人管理者へ限定してください。組織のDeny・SA利用制限・公開Runを禁止する組織ポリシーは上記allowだけでは回避できません。Cloud Tasks/Scheduler/Run/BuildのGoogle管理service agentには各APIの公式service-agent権限が必要で、本人やruntime SAへservice-agent roleを付与して代用しません。`bootstrap`後に専用SA等が作られ、`deploy`はそのSAを使用する二段階の手順です。

```bash
gcloud auth login
gcloud auth application-default login
npm ci
npm run typecheck
npm run lint
npm run build:google-cloud
./scripts/google-cloud --help
./scripts/google-cloud bootstrap --project YOUR_PROJECT \
  --region asia-northeast1 --env trial --state-bucket YOUR_STATE_BUCKET
./scripts/google-cloud plan --env trial
./scripts/google-cloud deploy --env trial
./scripts/google-cloud setup-slack --env trial --name 'チーム Roughmate'
```

`bootstrap`は必要APIを有効化し、公開アクセスを拒否した専用のversioning付きGCS stateバケットを作ります。Terraformのplanを確認し、`yes`で基盤を適用します。この段階ではCloud Runは作りません。`deploy`で専用build SAによるCloud BuildとArtifact Registryへの保存を行い、取得したimage digestをTerraformへ渡してHTTP/workerとSchedulerを作ります。再びplanを確認して`yes`を入力します。デフォルトcompute/build SAへのEditor付与は行いません。

APIはRun、Firestore、Cloud Tasks、Secret Manager、Scheduler、Storage、Artifact Registry、Cloud Build、IAM、IAM Credentials、Loggingを使用します。実行SAは専用named databaseと環境prefixの秘密へアクセスし、環境の3キューへenqueueします。Tasks用SAのactAsとOIDC生成権限は対象SAに限定します。HTTP入口だけを公開し、workerはTasks/Scheduler SAにだけ`run.invoker`を付与します。子secret作成の`secretmanager.secrets.create`は[作成APIがparent projectに対して認可する](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/create)ためproject単位で付与し、任意のSecret IDを新規作成できます。この権限を許容する専用セルフホスティングprojectが前提です。秘密の読取・版作成・版一覧はRoot完全名と子Botの環境prefixで制限し、削除・IAM変更・Admin/Editor権限は付与しません。

Cloud RunはHTTP最大2 instance、worker最大3 instance、最小0に設定します。キューは各2件/秒・同時2件、最大8試行・最大1日のretry設定です。Cloud TasksにSQSのDLQ相当は作りません。失敗をCloud Loggingと永続状態で確認し、未知の外部副作用を再送せず復旧してください。無料枠内である保証はありません。Firestore、保持secretの全version、GCS state、registry、Logging、build、OpenAIの課金を対象に予算を設定してください。

HTTP/worker URLには公式の[deterministic URL](https://docs.cloud.google.com/run/docs/triggering/https-request)を使います。DNS segment長を事前検証し、実配備のservice URL一覧と照合します。hash-based URLを推測しません。

`setup-slack`の秘密入力はSlack App Configuration access tokenとOpenAI API keyです。モデルは`gpt-6-luna`を使います。秘密を引数・tfvars・環境設定JSONへ書かず、Secret Managerへ保存します。表示された15分・一回限りのOAuth URLを、登録者本人のSlackアカウントで開いて承認してください。初回の本人とワークスペースを保存し、その後の承認をその境界へ固定します。URLはcode/stateを含むため保存・共有しないでください。

```bash
./scripts/google-cloud connect-registration --env trial
```

初回承認者のSlack Configuration refresh tokenを非表示入力します。tokenのteam/userを保存済み本人と照合した後に子Bot登録を接続します。以後、Root Homeから子Bot作成・OAuth・設定・資料登録を行います。

`.roughmate-google/ENV/config.json`にはproject・number・region・state bucket・image digestなど秘密以外の対象を保存します。権限は600、ディレクトリは700です。GCS stateも対象識別とIAM設定を含むためアクセスを制限してください。引越し時はこの設定と同じソース・本人認証を使い、対象のproject/region/envを変更しないでください。設定保存後の`bootstrap`再実行は既存stateを使用します。バケット作成直後の通信不明など設定が未保存の場合、同名バケットを自動で引き継ぎません。管理者が所有と状態を確認して復旧してください。

## 永続化と未知結果の扱い

各環境に`roughmate-ENV`の専用named Firestore databaseを作ります。既存の`(default)`や他環境は使いません。root/子namespaceとpkをdocument IDへ可逆符号化し、document条件・変更・複数document操作を原子transactionで行います。条件の失敗や同秒の期限切れを成功として扱いません。

Firestore Standardは[arrayの直接入れ子を保存できない](https://docs.cloud.google.com/firestore/native/docs/concepts/data-types)ため、業務documentをJSON payload文字列で保存します。objectのundefinedは省略し、arrayのundefined・非有限数・BigInt等は拒否します。nested Wiki scope、false、0を保持し、1 documentのpayloadは900,000 bytes以内に制限します。索引不要のpayloadは索引を無効化し、TTL用`expiresAt`は別のTimestampに写します。TTL削除は即時ではないため、認可と期限は共通業務側でも確認します。

Secret Managerのimmutable versionと共通の操作IDをFirestoreの耐久receiptで対応させます。API未送信のprepared、送信意図のpending、応答受信後のreadyを区別します。呼出前の中断が確認できた場合だけ元操作ID・同内容でpreparedから再開します。引数不正・親の不存在・権限拒否・状態不一致という明確な未作成応答だけをCASでrejectedとして記録し、原因の解消後に同じ操作ID・同じ内容で版追加を再試行できます。版追加呼出後の認証失敗（gRPC code16）・timeout・通信不明、pendingの版未発見は未作成とみなしません。同じ操作IDの既存版を確認し、OAuth交換・Slack App作成・Configuration rotation・未知の版追加を再送しません。復旧探索は直近100版に限定し、見つからない場合は安全停止します。版単位IAMは使いません。

Google RPCの上限は各RPCにつきCLIで30秒、workerで10秒です。通常のFirestore transactionでは読取とcommitそれぞれに上限を適用し、複数RPCの時間を累積しません。HTTPは既存のSlack受付2.5秒・OAuth callback8.5秒・ブラウザWiki8.5秒の残時間を上限とし、[SDKの初回認証・stub初期化](https://docs.cloud.google.com/nodejs/docs/reference/secret-manager/latest/secret-manager/v1.secretmanagerserviceclient#initialize)後にも残期限を確認します。Secret ManagerとCloud Tasksは[GAX timeoutとretry設定](https://googleapis.dev/nodejs/google-gax/latest/interfaces/CallOptions.html)を明示し、再試行は無効です。Firestoreも公開Settings/GAX clientConfigとgrpc-js transportを使い、読取・query・transaction/commitの送信直前に各RPCの上限とHTTPの絶対残期限を適用します。同じRPC要求のretryは初回送信期限を保持し、SDK retryが非同期コンテキストを失っても期限を延長しません。GAX retryを無効化し、期限切れの新送信を拒否、進行中のRPCをcancelします。cancel/deadlineはサーバー側commitの取り消しを保証しないため、応答不明の保存は耐久状態で照合します。SDK初期化・内部待機を含む処理全体の所要時間の保証ではありません。

専用initialize()だけの失敗では版追加APIは未呼出であり、preparedのまま同操作IDで再開できます。版追加APIを呼出した後の認証・期限・接続失敗で結果不明となった書込は、上限を変更しても再送可能にはなりません。HTTP期限後に新しい外部副作用は開始しません。ただし確定成功のready、明確な拒否のrejected、版追加APIの未呼出が証明された中断のpreparedという3種類の耐久receipt保存だけは、結果の喪失を防ぐためHTTP期限から独立したrole別の上限（CLI/HTTP30秒、worker10秒）内で行います。このreceipt後処理では読取からcommitまで合計でrole上限を共有します。元のattempt/sendAttemptと状態をCASで照合し、新しい版追加・Slack操作・Tasks送信へ広げません。 版追加直前のpending遷移transactionが失敗した場合も、その同じ実行でAPI未呼出を証明できるときだけ、secret/操作ID/digest/attempt/sendAttemptを照合してpendingをpreparedへ戻すか、同じ試行のpreparedを確認します。別試行・既知結果・不一致は上書きせず、復旧結果も不明なら停止します。次回の呼出だけで既存pendingを未送信と断定しません。そこで保存が不明なら既存のpendingから安全停止・照合します。診断ログには許可した数値gRPC statusだけを記録し、例外本文・詳細・秘密・URLは記録しません。Google SDKのpayload loggingも、有効な環境設定があっても利用するGAX各版の公開logging backendとFirestore loggerを明示無効化します。

Root App作成結果不明の場合、Slack管理画面の既存Appを調べ、次を実行します。

```bash
./scripts/google-cloud setup-slack --env trial --recover-app-id EXISTING_APP_ID
```

保存済み版があれば復旧し、新たなAppは作りません。秘密書込の操作receipt自体が存在しない場合、またはAPI未送信のprepared、明確な未作成のrejectedが記録された場合だけ、exportしたManifestの環境marker・接続先を照合して既存AppのClient ID、Client secret、Signing secret、OpenAI API keyを対話で入力します。元のcreateOwnerを操作IDに使用し、rejectedの場合は元と同じ内容だけを受け付けます。未知pendingの版未発見は手動入力による新IDの書込でも回避できません。Root OAuthの検証済み成功応答は、元の操作IDと消費済みstateの意図に関連付け、Secret Manager内の既存Signing secret由来の用途別HKDF/AES-GCMで暗号化して耐久保存します。平文tokenをFirestore/state/ログへ置きません。環境/App/team/owner/意図/操作ID/期限を照合し、暗号文保存後の中断は元のOAuthリンクの15分期限内に通常のsetup-slack --env trialを再実行して、workspace/秘密/groupの未完了保存だけを復旧できます。OAuth codeを再交換しません。暗号文は完了時に除去します。応答受信から暗号文の耐久保存までにプロセスが消失した場合、または送信意図保存後の未知結果で版が見つからない場合は復旧済みとは扱わず安全停止します。期限外・改ざん・別境界・完了済み意図の再利用も拒否します。子Appの未知作成状態は保存された共通状態を確認してください。GCP版CLIの子App手動復旧コマンドは未対応です。未確定状態を消して作り直すことはできません。

## ログ

アプリログには診断codeだけを記録し、受信URL・body・秘密を出しません。Cloud Run request logのURLはアプリ外で生成されるため、TerraformのLogging exclusionで対象HTTP serviceのOAuth callbackとWiki URLのrequest logを除外します。他serviceやproject全体のログは止めません。

これはdefault Logging sinkの保持対策です。[独立したsink](https://docs.cloud.google.com/logging/docs/routing/overview)、組織の集約sink、既存の転送先、ブラウザ履歴、Slackや運用端末の保存内容まで除外しません。管理者は独自sinkの同等filterも確認してください。既に保存されたログはこの設定では消えません。

## 通常アンインストール

次の操作は専用Slack AppsとCloud Run・キュー・Scheduler等を削除します。実行前に対象を確認してください。

```bash
./scripts/google-cloud remove-slack --env trial
./scripts/google-cloud uninstall --env trial
```

project/環境を表示し、`PROJECT/ENV`の入力で対象を確認します。保存されたRoot本人/teamとConfig tokenを照合し、子App一覧を表示して共通の停止・削除・アーカイブ処理を進めます。処理中や送信結果の再照合が必要なら基盤削除へ進みません。停止後150秒以降に同じコマンドを再実行してください。Root App削除の未知結果は90秒以降に不存在を確認するだけで、削除APIを再送しません。全Appの不存在を確認した後、`uninstall`はTerraform destroyのplanを表示し、`yes`で実行資源を削除します。

destroyがRoot秘密の削除後に中断しても、同じ`uninstall --env trial`で再開できます。秘密の読取より先に、保持DBの削除完了receiptとproject/環境/URL・app・本人/team・停止情報、空で削除中の子Bot registryを原子的に照合します。完了証跡が一致する場合だけ残りのdestroyへ進みます。未知の削除状態、境界の不一致、未完了の子Botがある場合は停止し、秘密が無いことを削除完了の根拠にはしません。

保持するのはnamed Firestore database内のroot/子設定・アーカイブ・Wiki・確定回答・操作receipt、動的な子BotのSecret Manager秘密と全version、専用GCS stateバケットです。DBはdeletion protectionとTerraform `ABANDON`で保持します。Root runtime/configuration秘密、環境SA/IAM、build source bucket、Artifact Registry、Cloud Run、Tasks、Scheduler、Logging exclusionは削除します。Firestore field設定はdestroyで解除されるため、アンインストール後はTTLとアプリの保持期限処理も動きません。アーカイブの既に記録された期限や明示消去証跡は保存されます。再導入で同じ保持DBを使うには管理者によるTerraform importと対象確認が必要です。自動再導入は行いません。

基盤を削除した後はブラウザ閲覧できません。保持データには課金が続く場合があります。Google Cloudの完全purgeは未対応です。このCLIから保持DB・子秘密・stateや他環境をまとめて削除する機能は提供しません。

同じ環境名での即時再導入も未対応です。削除した[Cloud Tasks queueの同名再作成は最大3日制限](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues/delete)されます。[custom IAM roleは7日以内ならundelete可能](https://docs.cloud.google.com/iam/docs/creating-custom-roles)ですが、削除後に同IDを新規作成できるまで最大44日かかります。新規試験は別の環境名と専用stateを使ってください。保持環境の復帰は、DBのimport、元stateとの照合、必要なroleの復帰、queue制約の確認を管理者が行ってから進めます。復帰により新規Rootが過去のアーカイブへ自動接続される保証はありません。

## ローカル検証

公開スナップショットで次のコマンドを実行できます。Terraformのbackend無効化はローカル構文検証用です。実導入のinitはCLIに任せてください。

```bash
npm run typecheck
npm run lint
npm run build
npm run build:google-cloud
terraform -chdir=infra/google-cloud init -backend=false
terraform -chdir=infra/google-cloud validate
```

公開版には開発用tests/fixturesを含めません。ローカル構文・build検証は実環境のIAM・通信・timeoutを保証しません。実環境でSlack署名、本人OAuth、子Bot、Tasks OIDC、送信・Wiki・archive・通常削除を検証してください。本番projectへのFirestore emulator接続は拒否します。
