VPS への自動デプロイ
====================

*stable* ブランチへの push で *.github/workflows/release.yaml* がイメージを
ビルドして GHCR に push し(`stable` と `sha-xxxxxxx` タグ)、その後 `deploy`
ジョブが SSH で VPS 上の *deploy.sh* を実行します。

*deploy.sh* は次の順に処理します。

1.  `pg_dump` で *backups/* にバックアップ(末尾の完了マーカーが無ければ中止)
2.  `docker compose pull hollo`
3.  `docker compose up -d hollo`
4.  `docker compose ps`

古いバックアップは直近 14 個(`BACKUP_KEEP`)を残して削除します。


VPS 側の準備
------------

### deploy.sh を置く

*compose.yml* と同じディレクトリに置きます(以下 */home/USER/hollo* の例)。

~~~~ bash
cp deploy.sh /home/USER/hollo/deploy.sh
chmod +x /home/USER/hollo/deploy.sh
~~~~

PostgreSQL のサービス名・ユーザー・DB 名が `postgres`/`hollo`/`hollo` でない
場合は、スクリプト先頭の `PG_SERVICE`、`PG_USER`、`PG_DB` を書き換えます。
デプロイ用ユーザーは `docker` を実行できる必要があります(`docker`
グループなど)。

### compose.yml の image を書き換える

~~~~ yaml
services:
  hollo:
    image: ghcr.io/OWNER/hollo:${HOLLO_TAG:-stable}
~~~~

### authorized_keys

デプロイ専用鍵の公開鍵を、*deploy.sh* しか実行できないように登録します。

~~~~
restrict,command="/home/USER/hollo/deploy.sh" ssh-ed25519 AAAA... hollo-deploy
~~~~

ワークフローの `script:` も同じ絶対パスに書き換えてください。


手動実行
--------

~~~~ bash
/home/USER/hollo/deploy.sh
~~~~

GitHub の Actions 画面から *release* ワークフローを `stable` ブランチで
*Run workflow* しても、ビルドとデプロイが走ります。


ロールバック
------------

GHCR に残っている `sha-xxxxxxx` タグを指定して起動し直します。

~~~~ bash
cd /home/USER/hollo
HOLLO_TAG=sha-xxxxxxx docker compose up -d hollo
~~~~

次に `stable` へ push されて *deploy.sh* が走ると、`stable` タグに戻ります。
DB を戻す必要があるときは *backups/* のダンプを使います。
