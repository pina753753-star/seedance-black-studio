# 参照画像安全検知サービス 問い合わせ・比較表

最終確認日: 2026-08-02

## 1. 目的

Pina Studioが参照画像付き動画生成を一般ユーザーへ再開する前に、実在人物・年齢リスク・既知および新規CSAM（児童性的虐待コンテンツ）の専用検知候補について、契約条件、データ取扱い、日本および海外からの利用可否を各社へ確認するための文書。

この文書は問い合わせ準備用であり、採用、契約、実API利用、画像送信、実装、一般ユーザー向け再開を意味しない。

## 2. Pina Studioの前提

問い合わせでは次の前提を伝える。

- サービス名: Pina Studio
- 運営拠点: 日本
- 運営形態: 小規模事業者によるAI動画生成サービス
- 現在の状態: 参照画像付き動画生成は一般ユーザー向けに停止中
- 将来の提供対象: 日本および海外の18歳以上のユーザー
- 利用者がアップロードした参照画像を動画生成前に検査する予定
- 実在人物へのなりすまし、未成年・児童画像、CSAMを安全に拒否することが目的
- 判定不能、サービス障害、タイムアウト時は生成を許可しない方針
- 検査前画像は非公開の隔離領域で扱い、合格前に公開URLを発行しない設計
- 実画像や違法画像を問い合わせ先へ添付しない

## 3. 公開情報で確認できた範囲

### 3-1. Safer by Thorn

公開情報で確認できたこと:

- Safer Matchは既知CSAMを暗号学的ハッシュと知覚ハッシュで照合する。
- ThornがホストするAPI版と、Safer Enterpriseのセルフホスト版が案内されている。
- API版は、アップロード機能を持つプラットフォーム向けとして案内されている。
- Safer Predictは、既知ハッシュに一致しない可能性のある新規・未登録CSAMを予測分類する候補である。
- 料金、最低契約額、契約資格、処理地域、保持期間、日本の小規模事業者が契約可能かは公開情報だけでは確認できない。
- 公式問い合わせフォームから個別確認が必要である。

公式情報:

- https://safer.io/resources/introducing-safer-essential-api-based-csam-detection/
- https://safer.io/solutions/
- https://safer.io/contact/

### 3-2. Microsoft PhotoDNA Cloud Service

公開情報で確認できたこと:

- 対象は、ユーザー生成コンテンツを扱う信頼されたオンラインサービス事業者や企業である。
- 利用資格は申請ごとに審査され、Microsoftの裁量で承認される。
- 適格な利用者には無料で提供されると案内されている。
- 画像は保存せず、直ちに安全なハッシュへ変換するとFAQで説明されている。
- 実際の違法画像をテストへ使わずに済む、無害な画像による統合テスト環境が案内されている。
- PhotoDNA Cloud Serviceは既知の児童搾取画像検出専用であり、一般的な成人向け画像分類には使用できない。
- 利用者自身の法的な報告義務を代替しない。
- サポートおよびSLAは提供されないと利用規約に記載されている。
- 日本の小規模事業者の適格性、日本および海外ユーザーの画像を扱えるか、処理地域、国外移転条件は個別確認が必要である。

公式情報:

- https://www.microsoft.com/en-us/photodna/CloudService
- https://www.microsoft.com/en-us/photodna/faq
- https://www.microsoft.com/en-us/photodna/TermsofUse

### 3-3. Amazon Rekognition

公開情報で確認できたこと:

- DetectFacesとRecognizeCelebritiesは従量課金の画像分析APIとして提供されている。
- 初期費用や最低利用料金はないと料金ページで案内されている。
- 東京リージョンを含む複数地域にエンドポイントがある。
- APIごとに対応リージョンが異なるため、採用予定APIをリージョン単位で確認する必要がある。
- DetectFacesの年齢範囲は推定値であり、本人確認や正確な年齢証明には使えない。
- RecognizeCelebritiesで一致しないことは、架空人物であることの証明にはならない。
- 画像のサービス改善利用、保持、オプトアウト、処理地域はAWSの契約・設定を確認する必要がある。
- Amazon Rekognition単独では、既知CSAMハッシュ照合や実在人物本人の同意確認を代替できない。

公式情報:

- https://aws.amazon.com/jp/rekognition/pricing/
- https://docs.aws.amazon.com/general/latest/gr/rekognition.html
- https://docs.aws.amazon.com/rekognition/latest/APIReference/API_DetectFaces.html
- https://docs.aws.amazon.com/rekognition/latest/APIReference/API_RecognizeCelebrities.html

## 4. 比較表

`未確認`は、公開情報だけでは断定せず、正式回答を待つ項目を示す。

| 確認項目 | Safer by Thorn | Microsoft PhotoDNA | Amazon Rekognition |
|---|---|---|---|
| 主な用途 | 既知・新規CSAM検知 | 既知CSAMハッシュ照合 | 顔検出、年齢範囲推定、有名人候補検出 |
| 日本の事業者が利用可能か | 未確認 | 審査制。日本の小規模事業者の適格性は未確認 | AWSアカウントから利用可能だが、採用APIとリージョンの確認が必要 |
| 海外ユーザーの画像を扱えるか | 未確認 | 未確認 | 技術的には可能だが、利用地域ごとの法令とデータ処理条件の確認が必要 |
| 国・地域別の利用制限 | 未確認 | 未確認 | API・リージョンごとに差異あり |
| 個人事業者・小規模事業者の契約 | 未確認 | 個別審査。承認保証なし | 通常のAWS契約で利用可能 |
| 初期費用・最低契約額 | 未確認 | 適格利用者は無料との案内。利用上限等は要確認 | 初期費用・最低料金なし |
| 従量料金 | 未確認 | 無料枠・取引制限あり。詳細要確認 | API呼び出しごとの従量課金 |
| 画像保存 | API版・セルフホスト版で要確認 | 画像を保存しないとの公式FAQ | API・設定・契約条件を確認 |
| 保存期間 | 未確認 | 画像本体は保存しないとの説明 | 未確認 |
| 処理地域 | 未確認 | 未確認 | 選択したAWSリージョン。ただしサービス内部処理条件も確認 |
| 日本国外へのデータ移転 | 未確認 | 未確認 | 選択リージョンとAWS契約条件を確認 |
| EU・英国・米国等の利用 | 未確認 | 未確認 | リージョン、法令、AWS契約条件を確認 |
| 学習・サービス改善利用 | 未確認 | 未確認 | オプトアウト設定を含め確認が必要 |
| テスト環境 | 未確認 | 無害な画像による統合環境あり | モック可能。実API利用は有料または無料枠 |
| SLA | 未確認 | なし | AWSサービス条件に基づく |
| 障害時の動作 | Pina Studio側で安全側停止が必要 | Pina Studio側で安全側停止が必要 | Pina Studio側で安全側停止が必要 |
| 法的報告義務 | 要確認 | 利用者側の義務を代替しない | AWSは法的助言を提供しないため別途確認 |
| 採用状態 | 未決定 | 未決定 | 未決定 |

## 5. 全社共通の問い合わせ項目

各社へ次を確認する。

### 契約・利用資格

1. 日本を拠点とする小規模事業者または個人事業者が契約できるか。
2. AI動画生成サービスで、利用者の参照画像を生成前に検査する用途が対象となるか。
3. 日本および海外の利用者がアップロードした画像を処理できるか。
4. 対象外の国・地域、制裁対象、輸出規制、年齢や業種による制限があるか。
5. 海外展開時に追加契約、追加審査、現地法人、代理人、規約変更が必要か。

### 料金

6. 初期費用、月額料金、従量料金、最低契約額、最低利用期間。
7. 無料試用、検証環境、サンドボックスの有無。
8. 画像1件あたり複数判定を行う場合の課金単位。
9. API障害、再試行、タイムアウト時にも課金されるか。
10. 日本円請求、消費税、海外送金、為替手数料の扱い。

### データ取扱い

11. 画像本体、サムネイル、ハッシュ、顔属性、判定結果を保存するか。
12. 各データの保存期間と削除方法。
13. 処理する国・地域、データセンター、再委託先。
14. 日本の利用者データと海外利用者データで処理場所が変わるか。
15. EU、英国、米国、カナダ、オーストラリア等の利用者データを扱えるか。
16. GDPR、UK GDPR、CCPA/CPRA等への対応文書やDPAを提供できるか。
17. 国外移転に必要な標準契約条項等を提供できるか。
18. サービス改善、モデル学習、人手レビューへ利用するか。
19. 学習・サービス改善利用を完全にオプトアウトできるか。
20. 契約終了時にデータを削除し、削除証明を提供できるか。

### セキュリティ

21. 通信時・保存時の暗号化。
22. SOC 2、ISO 27001等の監査報告書の有無。
23. アクセス制御、監査ログ、サブプロセッサ一覧。
24. セキュリティ事故時の通知期限。
25. APIキー漏えい時の停止・再発行手順。

### API・運用

26. API仕様、上限、通常応答時間、タイムアウト推奨値。
27. 障害情報の確認先、サポート窓口、SLA。
28. 判定不能、部分成功、JSON不正、5xx時の推奨処理。
29. 複数画像の一括処理と、1枚だけ失敗した場合の扱い。
30. 判定理由、信頼度、モデルバージョンを返すか。
31. 判定モデル更新時の事前通知があるか。
32. 誤判定時の異議申立て、調査、再判定手順。

### 児童安全・法的責任

33. 既知CSAM一致時に、サービス提供者が自動通報するか。
34. 利用者側に必要な通報先、期限、記録、証拠保存。
35. 日本の事業者が海外ユーザーの画像を扱う場合の報告義務について案内可能か。
36. NCMEC、警察、その他機関との役割分担。
37. 誤一致時の対応と、違法画像を人が直接開かずに確認する方法。
38. テスト用の無害な疑似一致データを提供できるか。

## 6. Safer by Thorn向け英語問い合わせ文

件名:

`Inquiry about Safer Match / Safer Predict availability for a Japan-based AI video platform serving users in Japan and overseas`

本文:

```text
Hello Safer by Thorn team,

We operate Pina Studio, a small AI video generation platform based in Japan. Our service is currently in a limited beta, and reference-image video generation remains disabled for general users while we design a child-safety and real-person protection workflow.

We plan to serve adult users in Japan and overseas. Before any uploaded reference image can be used for video generation, we intend to scan it in a private quarantine environment. If a required safety check is unavailable, times out, returns an invalid response, or cannot determine the risk, our system will fail closed and will not start generation.

We are evaluating Safer Match for known-CSAM detection and Safer Predict for potentially novel CSAM detection. We would appreciate written clarification on the following points:

1. Is a Japan-based small business or sole proprietor eligible to contract for Safer Match and/or Safer Predict?
2. Is our use case—screening user-uploaded reference images before AI video generation—eligible?
3. Can the services be used for images uploaded by users located both in Japan and overseas?
4. Are there any restricted countries or regions, or any additional requirements when serving users in the EU, UK, United States, Canada, Australia, or other regions?
5. Which deployment options are available for Safer Match and Safer Predict: Thorn-hosted API, self-hosted, or both?
6. What are the setup fees, monthly fees, usage-based fees, minimum commitments, and contract terms?
7. Is a sandbox or benign test dataset available so that we can test hit-handling without using illegal material?
8. For the hosted API, what data leaves our environment: original images, thumbnails, hashes, metadata, or classification outputs?
9. Where is data processed, which subprocessors are used, and what retention periods apply?
10. Is customer data used for model training, service improvement, or human review, and can all such use be opted out of?
11. Are a DPA, subprocessor list, security documentation, and international data-transfer terms available?
12. What API limits, typical latency, timeout guidance, SLA, and support channels apply?
13. What response should we expect for partial failures, timeouts, malformed responses, or service outages?
14. Does Safer or Thorn automatically report matches, or does the customer control reporting?
15. What reporting or evidence-preservation responsibilities would apply to a Japan-based customer serving users in multiple countries?
16. Can you provide guidance for reviewing potential matches without requiring our operator to directly open the image?

Please do not request or accept any actual suspected CSAM from us during this inquiry. We will only use benign test data approved by your team.

Thank you.

Pina Studio
Japan
```

## 7. Microsoft PhotoDNA向け英語問い合わせ文

件名:

`PhotoDNA Cloud Service eligibility for a Japan-based AI video platform serving users in Japan and overseas`

本文:

```text
Hello PhotoDNA team,

We operate Pina Studio, a small AI video generation platform based in Japan. Reference-image video generation is currently disabled for general users while we design a safety workflow for user-uploaded images.

We plan to serve adult users in Japan and overseas. Uploaded reference images would be screened before any AI video generation begins. Our system will fail closed if a required safety check is unavailable, times out, or returns an invalid or indeterminate result.

We are evaluating PhotoDNA Cloud Service for matching unknown user-uploaded images against known child-exploitation image signatures. We would appreciate written clarification on the following points:

1. Is a Japan-based small business or sole proprietor operating a user-generated AI video service eligible to apply?
2. Is screening reference images before AI video generation an eligible use under the service purpose limitation?
3. Can PhotoDNA Cloud Service process images uploaded by users located both in Japan and overseas?
4. Are there restricted countries or regions, or additional requirements for users in the EU, UK, United States, Canada, Australia, or other jurisdictions?
5. The public FAQ states that submitted images are not stored and are immediately converted to secure hashes. Does this apply to all production and test requests, logs, backups, diagnostics, and abuse investigations?
6. In which Azure regions or countries is processing performed, and can a customer select or restrict the processing region?
7. Are a DPA, subprocessor list, security documentation, and international data-transfer terms available?
8. Is any image-derived data used for product improvement, analytics, human review, or model development?
9. What transaction limits, throttling rules, timeout guidance, and error responses apply?
10. The terms state that no support or SLA is provided. Is there an operational contact for production incidents or security issues?
11. How can we access the benign integration environment described in the public FAQ?
12. What obligations would apply to a Japan-based customer when a match is returned for content uploaded by a user in another country?
13. Does Microsoft submit aggregate or identified reports to NCMEC, and what separate reporting steps remain the customer's responsibility?
14. What evidence should be retained, and how can potential matches be handled without requiring our operator to directly open the image?
15. Are there any fees, paid high-volume options, minimum commitments, or renewal requirements that are not described in the public FAQ?

Please do not request or accept any actual suspected illegal image from us during this inquiry. We will only use the benign test environment and approved test data.

Thank you.

Pina Studio
Japan
```

## 8. AWS向け問い合わせ文

AWSについては、一般的な契約・料金情報は公開されているため、AWS Supportまたは営業窓口へ次を確認する。

件名:

`Amazon Rekognition data processing and regional availability for a Japan-based AI video platform serving users in Japan and overseas`

本文:

```text
Hello AWS team,

We operate Pina Studio, a small AI video generation platform based in Japan. We plan to serve adult users in Japan and overseas. Reference-image generation is currently disabled for general users while we design a safety workflow.

We are evaluating Amazon Rekognition DetectFaces and RecognizeCelebrities as supporting checks before AI video generation. We understand that these APIs cannot prove identity, consent, or adulthood and will not be used as a replacement for CSAM-specific detection.

We would appreciate written clarification on the following points:

1. Are DetectFaces and RecognizeCelebrities available in the Asia Pacific (Tokyo) Region for new customers as of the response date?
2. Are the API behavior, supported attributes, celebrity coverage, quotas, and pricing identical across all available regions?
3. Can a Japan-based AWS customer process images uploaded by users located in Japan and overseas, including the EU, UK, United States, Canada, and Australia?
4. Does invoking the APIs in the Tokyo Region guarantee that the image bytes and derived data remain in that region?
5. Do any support, fraud prevention, telemetry, service improvement, backup, or human-review processes transfer image data or derived data outside the selected region?
6. What data is retained for DetectFaces and RecognizeCelebrities requests, and for how long?
7. How can we opt out of all use of AI service content for service improvement, and how can we verify that the opt-out is active?
8. Are a DPA, subprocessor list, security reports, and international data-transfer terms available for this use case?
9. What are the default and maximum quotas, recommended timeout values, retry guidance, and idempotency considerations?
10. Are failed, timed-out, or retried requests billable?
11. What changes to feature availability, model behavior, or celebrity coverage may occur without prior notice?
12. Is there a recommended way to test failure handling and boundary cases using only benign synthetic images?
13. Are there any additional restrictions for biometric information, face attributes, or celebrity recognition in particular countries or U.S. states?
14. Can AWS confirm that DetectFaces age ranges are estimates only and are not suitable as age verification?

We will not submit actual suspected illegal material during this inquiry or testing.

Thank you.

Pina Studio
Japan
```

## 9. 回答記録テンプレート

各社から回答を受けたら、原文を通常の公開文書へそのまま貼らず、秘密情報・担当者個人情報・契約限定情報を除いて要約する。

| 項目 | 回答 |
|---|---|
| 会社・サービス | |
| 問い合わせ日 | |
| 回答日 | |
| 回答経路 | |
| 日本の事業者が利用可能か | |
| 日本のユーザー画像 | |
| 海外ユーザー画像 | |
| 対象外の国・地域 | |
| 契約資格 | |
| 料金・最低契約 | |
| 処理地域 | |
| 保存データ | |
| 保存期間 | |
| 学習・改善利用 | |
| オプトアウト | |
| DPA・国外移転 | |
| SLA・サポート | |
| テスト環境 | |
| 法的報告義務 | |
| 未回答事項 | |
| 次の確認 | |

## 10. 問い合わせ時の禁止事項

- 実際のCSAMまたは疑い画像を添付しない。
- 未成年の性的画像、疑似CSAM、実在人物の非同意画像をテストに使わない。
- 本番利用者の画像、メールアドレス、ユーザーID、プロンプトを送らない。
- APIキー、シークレット、環境変数、Storage URLを送らない。
- サービス側から書面回答を得る前に「日本および海外で利用可能」と断定しない。
- 無料、保存なし、国内処理等を、公開ページの一文だけで契約条件として確定しない。
- 法的報告義務について、サービス会社の一般案内だけで最終判断しない。
- 問い合わせ送信、契約、実API試験はユーザーの事前承認なしに行わない。

## 11. 回答後の判断手順

1. 各社の書面回答を比較表へ反映する。
2. 日本および海外からの利用可否を国・地域ごとに整理する。
3. 料金、最低契約、保存、処理地域、学習利用、SLAを比較する。
4. 児童安全専門サービスと、顔・年齢の補助サービスを分けて評価する。
5. 法律専門家へ確認すべき項目を分離する。
6. 採用候補を決めても、まだ契約・実装・一般再開は行わない。
7. 非公開隔離アップロードの完成設計と実装コードを別PRでレビューする。
8. モックテスト、Preview、承認済みの安全な実API確認を順番に行う。
9. 一般ユーザー向け再開は、すべての完了条件を満たした後の別承認とする。

## 12. 現在の結論

- 日本および海外から利用できるかについて、Safer by ThornとPhotoDNAは正式回答が必要である。
- Amazon Rekognitionは日本から利用できる公開情報があるが、海外利用者の画像処理、地域制限、データ移転、顔情報に関する各国法令は別途確認が必要である。
- 現時点では採用サービスを決定しない。
- 一般ユーザー向け参照画像生成の停止を維持する。
- 問い合わせ送信、契約、実API利用、画像送信はまだ行わない。
