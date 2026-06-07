const cron = require('node-cron');
const { queryAll, queryOne, run } = require('./database');
const { searchRanking } = require('./crawler');
const { sendRankingAlert, sendDailyReport } = require('./emailer');

/**
 * 전체 키워드 순위 체크 실행
 */
async function runRankingCheck() {
  console.log(`\n[Scheduler] ===== 순위 체크 시작: ${new Date().toLocaleString('ko-KR')} =====`);

  try {
    const keywords = queryAll(`
      SELECT k.id as keyword_id, k.keyword, k.product_id,
             p.product_name, p.store_name, p.product_url, p.id as pid, p.catalog_id, p.product_url as purl
      FROM keywords k
      JOIN products p ON k.product_id = p.id
    `);

    if (keywords.length === 0) {
      console.log('[Scheduler] 등록된 키워드가 없습니다.');
      return [];
    }

    const results = [];
    const alertSettings = queryOne('SELECT * FROM alert_settings WHERE id = 1');

    for (const kw of keywords) {
      console.log(`[Scheduler] 검색 중: "${kw.keyword}" (${kw.product_name})`);

      try {
        const result = await searchRanking(
          kw.keyword,
          kw.store_name || '가시제거연구소',
          kw.product_name,
          3,
          kw.catalog_id || null,
          kw.purl || ''
        );

        // 순위 저장 (KST 시간)
        const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
        const isCatalog = result.isCatalog ? 1 : 0;
        run(
          'INSERT INTO rankings (keyword_id, rank_position, page_number, total_results, checked_at, is_catalog) VALUES (?, ?, ?, ?, ?, ?)',
          [kw.keyword_id, result.rank, result.page, result.totalResults, kstNow, isCatalog]
        );

        // 상품 정보 업데이트
        if (result.productInfo) {
          const price = result.productInfo.price || 0;
          const reviews = result.productInfo.reviewCount || 0;
          const image = result.productInfo.image || '';

          if (price || reviews) {
            run(
              "UPDATE products SET price = CASE WHEN ? > 0 THEN ? ELSE price END, review_count = CASE WHEN ? > 0 THEN ? ELSE review_count END, updated_at = ? WHERE id = ?",
              [price, price, reviews, reviews, kstNow, kw.pid]
            );
          }

          // ★ 항상 최신 네이버 API 이미지로 썸네일 업데이트
          if (image) {
            run('UPDATE products SET thumbnail_url = ?, updated_at = ? WHERE id = ?', [image, kstNow, kw.pid]);
            console.log(`  [썸네일] 업데이트: ${image.substring(0, 60)}...`);
          }
        }

        // 이전 순위 조회
        const allRankings = queryAll(
          'SELECT rank_position FROM rankings WHERE keyword_id = ? ORDER BY checked_at DESC LIMIT 2',
          [kw.keyword_id]
        );
        const prevRank = allRankings.length >= 2 ? allRankings[1].rank_position : null;
        const change = (prevRank && result.rank) ? result.rank - prevRank : 0;

        results.push({
          productName: kw.product_name,
          keyword: kw.keyword,
          rank: result.rank,
          prevRank: prevRank,
          change: change,
        });

        // 순위 변동 알림
        if (alertSettings?.is_enabled && prevRank && result.rank) {
          const dropAmount = result.rank - prevRank;
          if (Math.abs(dropAmount) >= (alertSettings.rank_drop_threshold || 5)) {
            await sendRankingAlert({
              productName: kw.product_name,
              keyword: kw.keyword,
              previousRank: prevRank,
              currentRank: result.rank,
              changeAmount: Math.abs(dropAmount),
              direction: dropAmount > 0 ? 'down' : 'up',
            }, alertSettings.email);
          }
        }

        console.log(`  → 결과: ${result.rank ? result.rank + '위' : '순위권 밖'} ${change ? `(${change > 0 ? '▼' : '▲'}${Math.abs(change)})` : ''}`);

        // 키워드 간 딜레이
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));

      } catch (error) {
        console.error(`  → 실패: ${error.message}`);
        results.push({
          productName: kw.product_name,
          keyword: kw.keyword,
          rank: null,
          change: 0,
          error: error.message,
        });
      }
    }

    // 일일 리포트 발송
    if (alertSettings?.is_enabled && alertSettings?.email) {
      await sendDailyReport(results, alertSettings.email);
    }

    console.log(`[Scheduler] ===== 순위 체크 완료 =====\n`);
    return results;

  } catch (error) {
    console.error('[Scheduler] 순위 체크 중 오류:', error.message);
    return [];
  }
}

function startScheduler() {
  const schedule = process.env.CRON_SCHEDULE || '0 8 * * *';

  if (!cron.validate(schedule)) {
    console.error('[Scheduler] 잘못된 크론 스케줄:', schedule);
    return;
  }

  cron.schedule(schedule, async () => {
    console.log('[Scheduler] 예약된 순위 체크 실행');
    await runRankingCheck();
  }, {
    timezone: 'Asia/Seoul'
  });

  console.log(`[Scheduler] 스케줄 등록 완료: ${schedule} (Asia/Seoul)`);
}

module.exports = { startScheduler, runRankingCheck };
