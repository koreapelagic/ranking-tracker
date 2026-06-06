require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB, queryAll, queryOne, run } = require('./database');
const { searchRanking, fetchProductInfo, extractKeywords } = require('./crawler');
const { startScheduler, runRankingCheck } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 이미지 프록시 (네이버 이미지 서버가 HTTPS 미지원이므로 서버에서 대신 가져옴)
// ============================================================

app.get('/api/image-proxy', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl || !imageUrl.includes('naver.net')) {
      return res.status(400).send('Invalid URL');
    }
    const axios = require('axios');
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 5000 });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400'); // 24시간 캐시
    res.send(response.data);
  } catch (e) {
    res.status(404).send('Image not found');
  }
});

// ============================================================
// 상품 API
// ============================================================

app.get('/api/products', (req, res) => {
  try {
    const products = queryAll('SELECT * FROM products ORDER BY created_at DESC');

    const result = products.map(product => {
      const keywords = queryAll(`
        SELECT k.*,
          (SELECT rank_position FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1) as latest_rank,
          (SELECT checked_at FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1) as last_checked,
          (SELECT rank_position FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1 OFFSET 1) as prev_rank,
          (SELECT page_number FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1) as latest_page
        FROM keywords k
        WHERE k.product_id = ?
      `, [product.id]);

      // ★ 네이버 이미지를 프록시 경로로 변환 (Mixed Content 차단 방지)
      if (product.thumbnail_url && product.thumbnail_url.includes('naver.net')) {
        const originalUrl = product.thumbnail_url.replace('https://', 'http://');
        product.thumbnail_url = '/api/image-proxy?url=' + encodeURIComponent(originalUrl);
      }

      return { ...product, keywords };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/products', (req, res) => {
  try {
    const { product_name, product_url, thumbnail_url, price, review_count, keywords } = req.body;

    if (!product_name) {
      return res.status(400).json({ error: '상품명은 필수입니다.' });
    }

    const result = run(
      'INSERT INTO products (product_name, product_url, thumbnail_url, price, review_count) VALUES (?, ?, ?, ?, ?)',
      [product_name, product_url || '', thumbnail_url || '', price || 0, review_count || 0]
    );
    const productId = result.lastInsertRowid;

    if (keywords && keywords.length > 0) {
      for (const kw of keywords) {
        if (kw.keyword && kw.keyword.trim()) {
          run(
            'INSERT INTO keywords (product_id, keyword, is_auto_extracted) VALUES (?, ?, ?)',
            [productId, kw.keyword.trim(), kw.is_auto ? 1 : 0]
          );
        }
      }
    }

    res.json({ success: true, productId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/products/:id', (req, res) => {
  try {
    // 관련 rankings 먼저 삭제
    const keywords = queryAll('SELECT id FROM keywords WHERE product_id = ?', [req.params.id]);
    for (const kw of keywords) {
      run('DELETE FROM rankings WHERE keyword_id = ?', [kw.id]);
    }
    run('DELETE FROM keywords WHERE product_id = ?', [req.params.id]);
    run('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/products/:id', (req, res) => {
  try {
    const { product_name, product_url, thumbnail_url, price, review_count } = req.body;
    run(
      'UPDATE products SET product_name = ?, product_url = ?, thumbnail_url = ?, price = ?, review_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [product_name, product_url, thumbnail_url, price, review_count, req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 키워드 API
// ============================================================

app.post('/api/keywords', (req, res) => {
  try {
    const { product_id, keyword, is_auto } = req.body;

    const count = queryOne('SELECT COUNT(*) as cnt FROM keywords WHERE product_id = ?', [product_id]);
    if (count.cnt >= 5) {
      return res.status(400).json({ error: '키워드는 상품당 최대 5개까지 등록 가능합니다.' });
    }

    const result = run(
      'INSERT INTO keywords (product_id, keyword, is_auto_extracted) VALUES (?, ?, ?)',
      [product_id, keyword, is_auto ? 1 : 0]
    );

    res.json({ success: true, keywordId: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/keywords/:id', (req, res) => {
  try {
    const { keyword } = req.body;
    if (!keyword || !keyword.trim()) {
      return res.status(400).json({ error: '키워드를 입력해주세요.' });
    }
    run('UPDATE keywords SET keyword = ? WHERE id = ?', [keyword.trim(), req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/keywords/:id', (req, res) => {
  try {
    run('DELETE FROM rankings WHERE keyword_id = ?', [req.params.id]);
    run('DELETE FROM keywords WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 순위 API (구체적 라우트를 :keywordId 앞에 배치)
// ============================================================

app.post('/api/rankings/check', async (req, res) => {
  try {
    const { keyword_id } = req.body;

    const kw = queryOne(`
      SELECT k.*, p.product_name, p.store_name, p.id as pid, p.catalog_id, p.product_url
      FROM keywords k JOIN products p ON k.product_id = p.id
      WHERE k.id = ?
    `, [keyword_id]);

    if (!kw) {
      return res.status(404).json({ error: '키워드를 찾을 수 없습니다.' });
    }

    const result = await searchRanking(kw.keyword, kw.store_name || '가시제거연구소', kw.product_name, 3, kw.catalog_id || null, kw.product_url || '');

    // KST 시간으로 저장
    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    run(
      'INSERT INTO rankings (keyword_id, rank_position, page_number, total_results, checked_at) VALUES (?, ?, ?, ?, ?)',
      [keyword_id, result.rank, result.page, result.totalResults, kstNow]
    );

    if (result.productInfo) {
      const price = result.productInfo.price || 0;
      const reviews = result.productInfo.reviewCount || 0;
      const image = result.productInfo.image || '';

      // 가격, 리뷰수 업데이트
      if (price || reviews) {
        run(
          'UPDATE products SET price = CASE WHEN ? > 0 THEN ? ELSE price END, review_count = CASE WHEN ? > 0 THEN ? ELSE review_count END, updated_at = ? WHERE id = ?',
          [price, price, reviews, reviews, kstNow, kw.pid]
        );
      }

      // ★ 썸네일이 비어있을 때만 네이버 API 이미지로 채움 (기존 이미지는 유지)
      if (image) {
        const currentProduct = queryOne('SELECT thumbnail_url FROM products WHERE id = ?', [kw.pid]);
        if (!currentProduct || !currentProduct.thumbnail_url) {
          run('UPDATE products SET thumbnail_url = ?, updated_at = ? WHERE id = ?', [image, kstNow, kw.pid]);
          console.log(`  [썸네일] 이미지 자동 설정: ${image.substring(0, 60)}...`);
        }
      }
    }

    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rankings/check-all', async (req, res) => {
  try {
    res.json({ success: true, message: '순위 체크를 시작합니다.' });
    runRankingCheck().then(results => {
      console.log('[API] 일괄 순위 체크 완료:', results.length, '건');
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// URL에서 상품정보 + 키워드 자동 추출
// ============================================================
app.post('/api/extract', async (req, res) => {
  try {
    const { product_url } = req.body;

    if (!product_url) {
      return res.status(400).json({ error: '상품 URL을 입력해주세요.' });
    }

    const productInfo = await fetchProductInfo(product_url);
    if (!productInfo || !productInfo.name) {
      return res.status(400).json({ error: '상품 정보를 가져올 수 없습니다. URL을 확인해주세요.' });
    }

    const autoKeywords = extractKeywords(productInfo.name);

    res.json({
      success: true,
      product: {
        name: productInfo.name,
        price: productInfo.price,
        image: productInfo.image,
        reviewCount: productInfo.reviewCount,
      },
      keywords: autoKeywords,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 알림 설정 API
// ============================================================

app.get('/api/alerts', (req, res) => {
  try {
    const settings = queryOne('SELECT * FROM alert_settings WHERE id = 1');
    res.json(settings || { is_enabled: 0, email: '', rank_drop_threshold: 5 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/alerts', (req, res) => {
  try {
    const { email, is_enabled, rank_drop_threshold } = req.body;
    run(
      'UPDATE alert_settings SET email = ?, is_enabled = ?, rank_drop_threshold = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
      [email, is_enabled ? 1 : 0, rank_drop_threshold || 5]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 대시보드 통계 API
// ============================================================
app.get('/api/dashboard', (req, res) => {
  try {
    const totalProducts = queryOne('SELECT COUNT(*) as cnt FROM products')?.cnt || 0;
    const totalKeywords = queryOne('SELECT COUNT(*) as cnt FROM keywords')?.cnt || 0;
    const kstToday = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const todayChecks = queryOne("SELECT COUNT(*) as cnt FROM rankings WHERE DATE(datetime(checked_at, '+9 hours')) = ?", [kstToday])?.cnt || 0;
    const rank1Count = queryOne(`
      SELECT COUNT(DISTINCT k.product_id) as cnt
      FROM keywords k
      JOIN rankings r ON r.keyword_id = k.id
      WHERE r.rank_position = 1
      AND r.checked_at = (SELECT MAX(checked_at) FROM rankings WHERE keyword_id = k.id)
    `)?.cnt || 0;

    res.json({ totalProducts, totalKeywords, todayChecks, rank1Count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 기간별 순위 조회 API
// ============================================================
app.get('/api/rankings/history/:keywordId', (req, res) => {
  try {
    const { from, to } = req.query;
    let sql = 'SELECT * FROM rankings WHERE keyword_id = ?';
    const params = [req.params.keywordId];
    if (from) { sql += " AND DATE(checked_at) >= ?"; params.push(from); }
    if (to) { sql += " AND DATE(checked_at) <= ?"; params.push(to); }
    sql += ' ORDER BY checked_at DESC LIMIT 365';
    const rankings = queryAll(sql, params);
    res.json(rankings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 전체 상품 기간별 순위 테이블 API (기본 최근 7일)
// ============================================================
app.get('/api/rankings/table', (req, res) => {
  try {
    let { from, to } = req.query;
    // 기본값: 최근 7일 (KST 기준)
    if (!from && !to) {
      const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      to = kstNow.toISOString().slice(0, 10);
      const kstWeek = new Date(kstNow.getTime() - 7 * 24 * 60 * 60 * 1000);
      from = kstWeek.toISOString().slice(0, 10);
    }

    let dateSql = "SELECT DISTINCT DATE(checked_at) as d FROM rankings WHERE 1=1";
    const dateParams = [];
    if (from) { dateSql += " AND DATE(checked_at) >= ?"; dateParams.push(from); }
    if (to) { dateSql += " AND DATE(checked_at) <= ?"; dateParams.push(to); }
    dateSql += " ORDER BY d DESC LIMIT 31";
    const dates = queryAll(dateSql, dateParams).map(r => r.d);

    const products = queryAll('SELECT * FROM products ORDER BY product_name');
    const result = products.map(p => {
      const keywords = queryAll('SELECT * FROM keywords WHERE product_id = ?', [p.id]);
      const kwData = keywords.map(kw => {
        const rankings = {};
        const times = {};
        dates.forEach(d => {
          const r = queryOne("SELECT rank_position, checked_at FROM rankings WHERE keyword_id = ? AND DATE(checked_at) = ? ORDER BY checked_at DESC LIMIT 1", [kw.id, d]);
          rankings[d] = r ? r.rank_position : null;
          times[d] = r ? r.checked_at : null;
        });
        return { keyword: kw.keyword, keyword_id: kw.id, rankings, times };
      });
      return { product_id: p.id, product_name: p.product_name, keywords: kwData };
    });
    res.json({ dates, products: result, from, to });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// Overview (주요 이슈) API — 버그수정: HAVING→서브쿼리
// ============================================================
app.get('/api/overview', (req, res) => {
  try {
    // 1위 달성
    const rank1Products = queryAll(`
      SELECT DISTINCT p.product_name, k.keyword
      FROM keywords k JOIN products p ON k.product_id = p.id
      JOIN rankings r ON r.keyword_id = k.id
      WHERE r.rank_position = 1
      AND r.checked_at = (SELECT MAX(checked_at) FROM rankings WHERE keyword_id = k.id)
    `);

    // 모든 키워드의 현재/이전 순위를 먼저 가져옴
    const allKws = queryAll(`
      SELECT k.id, k.keyword, p.product_name,
        (SELECT rank_position FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1) as curr_rank,
        (SELECT rank_position FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1 OFFSET 1) as prev_rank,
        (SELECT checked_at FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1) as last_checked
      FROM keywords k JOIN products p ON k.product_id = p.id
    `);

    // JS에서 필터링
    const bigRisers = allKws
      .filter(r => r.prev_rank && r.curr_rank && (r.prev_rank - r.curr_rank) >= 3)
      .sort((a, b) => (b.prev_rank - b.curr_rank) - (a.prev_rank - a.curr_rank))
      .slice(0, 5);

    const bigDroppers = allKws
      .filter(r => r.prev_rank && r.curr_rank && (r.curr_rank - r.prev_rank) >= 3)
      .sort((a, b) => (b.curr_rank - b.prev_rank) - (a.curr_rank - a.prev_rank))
      .slice(0, 5);

    // 미조회
    const unchecked = queryOne(`
      SELECT COUNT(DISTINCT k.id) as cnt FROM keywords k
      LEFT JOIN rankings r ON r.keyword_id = k.id
      WHERE r.id IS NULL
    `)?.cnt || 0;

    const lastCheck = queryOne("SELECT MAX(checked_at) as t FROM rankings")?.t || null;

    // 스토어 인사이트 생성
    const totalKws = allKws.length;
    const checkedKws = allKws.filter(r => r.curr_rank).length;
    const rank1Kws = allKws.filter(r => r.curr_rank === 1);
    const top10Kws = allKws.filter(r => r.curr_rank && r.curr_rank <= 10);
    const outKws = allKws.filter(r => r.curr_rank && r.curr_rank > 10);
    const avgRank = checkedKws > 0 ? Math.round(allKws.filter(r=>r.curr_rank).reduce((s,r)=>s+r.curr_rank,0) / checkedKws) : 0;

    const insights = [];
    if (checkedKws === 0) {
      insights.push('아직 순위 데이터가 없습니다. "전체 순위 조회"를 실행하세요.');
    } else {
      // 보고형 3줄 인사이트
      const kstDate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(5, 10).replace('-', '/');

      // 1줄: 전체 현황 요약
      const r1Names = rank1Kws.length > 0 ? ` (1순위: ${rank1Kws.slice(0,3).map(r=>r.keyword).join(', ')})` : '';
      insights.push(`[${kstDate} 현황] 전체 ${totalKws}개 키워드 중 TOP10 ${top10Kws.length}개, 1순위 ${rank1Kws.length}개 달성${r1Names}, 평균 순위 ${avgRank}위입니다.`);

      // 2줄: 변동 사항
      if (bigRisers.length > 0 || bigDroppers.length > 0) {
        const parts = [];
        if (bigRisers.length > 0) parts.push(`급상승 ${bigRisers.slice(0,2).map(r=>`"${r.keyword}" ▲${r.prev_rank-r.curr_rank}`).join(', ')}`);
        if (bigDroppers.length > 0) parts.push(`급하락 ${bigDroppers.slice(0,2).map(r=>`"${r.keyword}" ▼${r.curr_rank-r.prev_rank}`).join(', ')}`);
        insights.push(`[순위 변동] ${parts.join(' / ')}. 급변동 키워드는 경쟁 상품 동향을 확인해주세요.`);
      } else {
        insights.push('[순위 변동] 전일 대비 큰 변동 없이 안정적입니다. 현재 순위 유지를 위한 리뷰 관리에 집중해주세요.');
      }

      // 3줄: 액션 제안
      if (outKws.length > 0 && rank1Kws.length < 10) {
        insights.push(`[개선 제안] 순위권 밖 키워드 ${outKws.length}개 중 상위 진입 가능 키워드를 선별하여 상품명 최적화 및 리뷰 확보에 집중하면 목표(1순위 10개) 달성에 가까워집니다.`);
      } else if (rank1Kws.length >= 10) {
        insights.push('[목표 달성] 1순위 10개 목표를 달성했습니다! 현재 순위를 유지하면서 추가 키워드 확장을 검토해주세요.');
      } else {
        insights.push(`[개선 제안] 목표 달성까지 1순위 ${10 - rank1Kws.length}개가 더 필요합니다. TOP10 키워드 ${top10Kws.length}개를 우선 공략하세요.`);
      }
    }

    res.json({ rank1Products, bigRisers, bigDroppers, uncheckedKeywords: unchecked, lastCheck, insights });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 보고서 다운로드 (CSV)
// ============================================================
app.get('/api/report/csv', (req, res) => {
  try {
    const products = queryAll('SELECT * FROM products ORDER BY id');
    const rows = ['\uFEFF상품ID,상품명,가격,리뷰수,키워드,현재순위,이전순위,변동,체크시간'];

    for (const p of products) {
      const kws = queryAll(`
        SELECT k.*,
          (SELECT rank_position FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1) as curr,
          (SELECT rank_position FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1 OFFSET 1) as prev,
          (SELECT checked_at FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1) as checked
        FROM keywords k WHERE k.product_id = ?
      `, [p.id]);

      for (const kw of kws) {
        const change = (kw.prev && kw.curr) ? kw.prev - kw.curr : '';
        rows.push(`${p.id},"${p.product_name}",${p.price||0},${p.review_count||0},"${kw.keyword}",${kw.curr||''},${kw.prev||''},${change},"${kw.checked||''}"`);
      }
    }

    const kstDate = new Date(Date.now() + 9*60*60*1000).toISOString().slice(0,10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ranking-report-${kstDate}.csv"`);
    res.send(rows.join('\n'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// PDF 보고서용 데이터 API
// ============================================================
app.get('/api/report/data', (req, res) => {
  try {
    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const kstDate = kstNow.toISOString().slice(0, 10);
    const kstTime = kstNow.toISOString().replace('T', ' ').slice(0, 19);

    const products = queryAll('SELECT * FROM products ORDER BY id');
    const allKws = queryAll(`
      SELECT k.id, k.keyword, k.product_id, p.product_name,
        (SELECT rank_position FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1) as curr_rank,
        (SELECT rank_position FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1 OFFSET 1) as prev_rank,
        (SELECT checked_at FROM rankings WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1) as last_checked
      FROM keywords k JOIN products p ON k.product_id = p.id
    `);

    const totalKws = allKws.length;
    const checkedKws = allKws.filter(r => r.curr_rank).length;
    const rank1Kws = allKws.filter(r => r.curr_rank === 1);
    const top10Kws = allKws.filter(r => r.curr_rank && r.curr_rank <= 10);
    const outKws = allKws.filter(r => !r.curr_rank || r.curr_rank > 300);
    const avgRank = checkedKws > 0 ? Math.round(allKws.filter(r => r.curr_rank).reduce((s, r) => s + r.curr_rank, 0) / checkedKws) : 0;
    const bigRisers = allKws.filter(r => r.prev_rank && r.curr_rank && (r.prev_rank - r.curr_rank) >= 3).sort((a, b) => (b.prev_rank - b.curr_rank) - (a.prev_rank - a.curr_rank)).slice(0, 5);
    const bigDroppers = allKws.filter(r => r.prev_rank && r.curr_rank && (r.curr_rank - r.prev_rank) >= 3).sort((a, b) => (b.curr_rank - b.prev_rank) - (a.curr_rank - a.prev_rank)).slice(0, 5);

    const productData = products.map(p => {
      const kws = allKws.filter(k => k.product_id === p.id);
      return {
        name: p.product_name,
        price: p.price,
        reviewCount: p.review_count,
        keywords: kws.map(k => ({
          keyword: k.keyword,
          rank: k.curr_rank,
          prevRank: k.prev_rank,
          change: (k.prev_rank && k.curr_rank) ? k.prev_rank - k.curr_rank : null,
        })),
      };
    });

    res.json({
      date: kstDate,
      time: kstTime,
      summary: { totalProducts: products.length, totalKws, checkedKws, rank1: rank1Kws.length, top10: top10Kws.length, outOfRank: outKws.length, avgRank },
      rank1Keywords: rank1Kws.map(r => ({ keyword: r.keyword, product: r.product_name })),
      bigRisers: bigRisers.map(r => ({ keyword: r.keyword, product: r.product_name, prev: r.prev_rank, curr: r.curr_rank })),
      bigDroppers: bigDroppers.map(r => ({ keyword: r.keyword, product: r.product_name, prev: r.prev_rank, curr: r.curr_rank })),
      products: productData,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 순위 개별 조회 (반드시 /api/rankings/table, /api/rankings/history 보다 뒤에 배치)
app.get('/api/rankings/:keywordId', (req, res) => {
  try {
    const rankings = queryAll(
      'SELECT * FROM rankings WHERE keyword_id = ? ORDER BY checked_at DESC LIMIT 30',
      [req.params.keywordId]
    );
    res.json(rankings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SPA 폴백
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// 기본 데이터 시딩
// ============================================================
function seedDefaultData() {
  // 기존 데이터 삭제 후 새로 시딩 (전체 상품 업데이트)
  // v3 상품명 정확 매칭 업데이트: 축약 상품명 → CSV 원본 상품명
  const nameCheck = queryOne("SELECT product_name FROM products WHERE product_name LIKE '%빵가루 냉동 튀겨나온%' LIMIT 1");
  const existingCount = queryOne('SELECT COUNT(*) as cnt FROM products')?.cnt || 0;
  if (existingCount > 0 && !nameCheck) {
    console.log('[Seed] v3 상품명 정확 업데이트를 위해 데이터 리셋...');
    run('DELETE FROM rankings');
    run('DELETE FROM keywords');
    run('DELETE FROM products');
  }

  const productCount = queryOne('SELECT COUNT(*) as cnt FROM products')?.cnt || 0;
  if (productCount === 0) {
    console.log('[Seed] 40개 상품 데이터 등록 중...');

    const products = [
      { id: 13267205867, name: '가시제거연구소 바삭 통 새우튀김 300g 빵가루 냉동 튀겨나온 왕새우튀김', price: 15900, image: 'http://shop1.phinf.naver.net/20260320_206/1773973551017b27HY_JPEG/6120828808220501_2001760366.jpg', keywords: ['새우튀김', '빵가루새우튀김'] },
      { id: 12862953615, name: '가시제거연구소 튀김요리가 맛있어지는 케이준소스 200g 튀김소스', price: 4900, image: 'http://shop1.phinf.naver.net/20260116_6/1768544696060KiFxJ_JPEG/6149722875203808_1259254666.jpg', keywords: ['케이준소스', '튀김소스'] },
      { id: 12862860631, name: '가시제거연구소 생선구이가 맛있어지는 양념소스 180g', price: 4000, image: 'http://shop1.phinf.naver.net/20260112_300/1768184226483jJT8i_JPEG/47770143877874073_364213785.jpg', keywords: ['생선양념', '생선구이 양념'] },
      { id: 12637923363, name: '가시제거연구소 오징어밥상 250g 냉동 간편한 손질 오징어 숙회', price: 12900, image: 'http://shop1.phinf.naver.net/20251125_147/17640436598057Nj7s_JPEG/98176616012254322_918145043.jpg', keywords: ['오징어', '손질오징어', '오징어숙회'] },
      { id: 12601079032, name: '가시제거연구소 국내산 제철 순살 전갱이 500g 메가리 아지 생선 구이', price: 17900, image: 'http://shop1.phinf.naver.net/20251230_241/1767080361188r56Gu_JPEG/43541706958610111_1615318895.jpg', keywords: ['전갱이', '손질전갱이', '메가리'] },
      { id: 12601076615, name: '가시제거연구소 국내산 제철 농어 800g 두툼 생선 구이 스테이크 흰살', price: 25900, image: 'http://shop1.phinf.naver.net/20251230_233/1767080246079Ej2Q9_JPEG/101895924088274344_1122500356.jpg', keywords: ['농어', '농어스테이크', '생선스테이크'] },
      { id: 12601071070, name: '가시제거연구소 볼락밥상 650g 노르웨이 순살 생선구이 적어 열기 금태', price: 18900, image: 'http://shop1.phinf.naver.net/20260109_68/1767940708542gmrHb_JPEG/6284250028822344_162339721.jpg', keywords: ['볼락'] },
      { id: 12601067334, name: '가시제거연구소 명란무침 300g 저염 명란젓 명란장 한식 요리 비빔밥', price: 19900, image: 'http://shop1.phinf.naver.net/20251222_128/1766379877452t8cTL_JPEG/276900434092652_1878142143.jpg', keywords: ['명란', '명란젓', '명란요리'], catalogId: '58632905246' },
      { id: 12601055551, name: '가시제거연구소 모짜렐라 대구 생선까스 410g 순살 치즈 에어프라이어 튀김', price: 13900, image: 'http://shop1.phinf.naver.net/20251215_298/17657723732373FhBm_JPEG/34888255269938586_1379445467.jpg', keywords: ['생선까스', '생선튀김', '대구튀김'] },
      { id: 12601029452, name: '가시제거연구소 고등어밥상 네이버라벨 고등어 330g (3미) 순살 노르웨이 고등어 생선', price: 14900, image: 'http://shop1.phinf.naver.net/20260401_217/1775001176681RKtBe_JPEG/202303726824301_292130828.jpg', keywords: ['고등어', '순살고등어'], catalogId: '90145540308' },
      { id: 11900926938, name: '가시제거연구소 오피쉬후라이드 500g 순살 가자미 생선 튀김', price: 15900, image: 'http://shop1.phinf.naver.net/20250609_113/1749436322000ivWNt_JPEG/3609425776436319_1297331225.jpg', keywords: ['가자미생선튀김', '가자미튀김'] },
      { id: 11288321199, name: '가시제거연구소 새우까스 콤보 600g 2개 통새우살 2가지맛 패티', price: 30900, image: 'http://shop1.phinf.naver.net/20251126_278/17641179879432ohaJ_JPEG/61596122493712602_534978965.jpg', keywords: ['새우까스', '새우패티', '새우버거패티'] },
      { id: 11263036093, name: '가시제거연구소 양파타타르 소스 500g', price: 6900, image: 'http://shop1.phinf.naver.net/20250107_247/17362328520805Uzhr_JPEG/70365699849921834_1422473792.jpg', keywords: ['타르타르소스', '생선까스소스'] },
      { id: 11126838323, name: '가시제거연구소 새콤60 새우까스콤보 600g 새우살 60% 버거 패티', price: 18900, image: 'http://shop1.phinf.naver.net/20250513_98/1747118158271BjdBJ_JPEG/91678046956406702_685837627.jpg', keywords: ['새우까스', '새우패티', '새우버거패티'] },
      { id: 10949991971, name: '가시제거연구소 반건조 납세미 650g 순살 말린 손질 가자미', price: 19900, image: 'http://shop1.phinf.naver.net/20241004_219/1728022037773W3Dz2_JPEG/13207003546343032_1450436201.jpg', keywords: ['납세미'] },
      { id: 10072368973, name: '가시제거연구소 떡 미역국밥상 500g 2개', price: 16900, image: 'http://shop1.phinf.naver.net/20240402_135/1712039266906Gztjr_JPEG/113175155583978517_2135002811.jpg', keywords: ['미역국', '미역국밀키트', '떡미역국'] },
      { id: 10045163381, name: '가시제거연구소 피쉬너겟 500g 피쉬앤칩스 순살 대구 튀김', price: 17900, image: 'http://shop1.phinf.naver.net/20240319_148/1710835230083MwCpA_JPEG/111971009784936637_1752441289.jpg', keywords: ['피쉬너겟', '생선튀김'] },
      { id: 9615822213, name: '가시제거연구소 매콤가득 생선조림소스 500g', price: 6900, image: 'http://shop1.phinf.naver.net/20241120_286/1732069065928KgaqC_JPEG/79902816634057869_1520220273.jpg', keywords: ['생선조림소스'] },
      { id: 9615817939, name: '가시제거연구소 레몬타타르 디핑소스 500g 타르타르', price: 6900, image: 'http://shop1.phinf.naver.net/20241029_195/1730178446772ad0r2_JPEG/9753810577365963_89322321.jpg', keywords: ['타르타르소스', '디핑소스'] },
      { id: 9417072075, name: '가시제거연구소 연어덮밥 135g 노르웨이 냉장 생연어 샐러드 포케', price: 11900, image: 'http://shop1.phinf.naver.net/20240830_129/1724994643314RI5Ey_JPEG/7594213070562679_1359670727.jpg', keywords: ['연어덮밥', '연어샐러드', '연어포케'] },
      { id: 9045239663, name: '가시제거연구소 제로새우 450g 생새우 붉은 칵테일 자연산', price: 17900, image: 'http://shop1.phinf.naver.net/20250513_157/1747115237965SgSvS_JPEG/52796022104740457_39498733.jpg', keywords: ['생새우', '손질새우', '제로새우'] },
      { id: 8096185489, name: '가시제거연구소 노바시새우 20미(450g) 특대 손질 냉동 깐새우 튀김용 감바스 파스타', price: 11900, image: 'http://shop1.phinf.naver.net/20230620_143/1687243680035qtXyV_JPEG/3512174869347613_1801407386.jpg', keywords: ['노바시새우', '튀김용새우', '손질새우', '깐새우'] },
      { id: 6995579069, name: '가시제거연구소 명란밥상 400g 명란 무색소 저염 냉동', price: 29900, image: 'http://shop1.phinf.naver.net/20251020_240/1760943512186hcfYL_JPEG/36716349195878476_1114774010.jpg', keywords: ['명란', '명란젓', '명란요리'] },
      { id: 6804007862, name: '가시제거연구소 순살 코다리밥상 500g 찜 조림 손질 강정 명태', price: 15900, image: 'http://shop1.phinf.naver.net/20260406_114/1775432342071E6Vti_JPEG/33810438310987692_2112508843.jpg', keywords: ['코다리', '코다리찜', '순살코다리'] },
      { id: 6073502491, name: '가시제거연구소 삼치구이 70g 삼치밥상 대삼치 순살생선 생선구이 전자레인지', price: 17500, image: 'http://shop1.phinf.naver.net/20250528_212/1748414579998j8TWF_JPEG/85287050736013898_1527575654.jpg', keywords: ['삼치', '삼치구이'] },
      { id: 6026142046, name: '가시제거연구소 연어밥상 스테이크 150g 노르웨이 숙성 구이용 필렛', price: 11900, image: 'http://shop1.phinf.naver.net/20211123_217/1637643240571J4Gcy_JPEG/38779075393432730_224946906.jpg', keywords: ['연어스테이크', '연어필렛', '연어'] },
      { id: 5950571543, name: '가시제거연구소 순살 가자미살 50g X 5개 가재미 흰살 아기 아이 생선', price: 14500, image: 'http://shop1.phinf.naver.net/20211026_238/1635209652210vOokg_JPEG/36345540914872683_963518876.jpg', keywords: ['순살가자미', '가자미', '가자미살'] },
      { id: 5697406275, name: '황게장밥상 순살 양념게장 국내산 깨다시 꽃게장 500g', price: 13900, image: 'http://shop1.phinf.naver.net/20210706_73/1625548379252jhfQ4_JPEG/26684267884931012_1190739942.jpg', keywords: ['양념게장', '게장황게장'], catalogId: '58377276294' },
      { id: 5375916361, name: '가시제거연구소 삼치밥상 800g 대삼치 순살 손질 생선 구이', price: 23900, image: 'http://shop1.phinf.naver.net/20211203_46/1638519036777J7dBr_JPEG/39654935361087827_737697484.jpg', keywords: ['삼치', '삼치구이'] },
      { id: 5373081072, name: '가시제거연구소 바지락 미역국밥상 600g 2개 미역국 밀키트', price: 16900, image: 'http://shop1.phinf.naver.net/20251201_193/1764541350339yXuPe_JPEG/224534451252417_2067669041.jpg', keywords: ['바지락미역국', '미역국', '미역국밀키트'] },
      { id: 5336682941, name: '고등어밥상 핑크라벨 500g 노르웨이 가시 제거 순살 고등어', price: 17900, image: 'http://shop1.phinf.naver.net/20260330_55/17748454190958mtuO_JPEG/3986150649556250_657004684.jpg', keywords: ['고등어', '순살고등어', '가시제거고등어'] },
      { id: 5303676331, name: '가시제거연구소 가자미밥상 생선까스 550g 흰살 에어프라이어 튀김', price: 15900, image: 'http://shop1.phinf.naver.net/20260106_190/1767657464358w8gUi_JPEG/25283205331178880_370743150.jpg', keywords: ['가자미', '생선까스', '생선튀김'] },
      { id: 4991882884, name: '가시제거연구소 진저소이 고등어 구이 100g 즉석 양념 순살 생선구이', price: 17500, image: 'http://shop1.phinf.naver.net/20250709_29/1752034805905t3kxg_JPEG/35110270626324988_1838059280.jpg', keywords: ['양념고등어구이', '고등어구이'] },
      { id: 4881210829, name: '가시제거연구소 고등어밥상 국산 고등어 500g 순살 저염 냉동', price: 13900, image: 'http://shop1.phinf.naver.net/20260330_159/177484543600527Vrz_JPEG/29393827231754764_657211106.jpg', keywords: ['국산고등어', '고등어', '순살고등어', '손질고등어'] },
      { id: 4776056811, name: '가시제거연구소 순살 가자미밥상 650g 무염 흰살 아기 생선', price: 17900, image: 'http://shop1.phinf.naver.net/20250521_268/1747807756877iauU3_JPEG/11474885958721619_1411489277.jpg', keywords: ['가자미', '손질가자미'] },
      { id: 4428358151, name: '칵테일새우 200g 생 새우살 볶음밥 새우전 냉동', price: 5200, image: 'http://shop1.phinf.naver.net/20190409_279/kp6011_1554794391670cQ7W5_JPEG/78101551289729156_83725627.jpg', keywords: ['칵테일새우', '새우', '냉동새우'] },
      { id: 4428244243, name: '생 칵테일새우 900g 생 새우살 특대 냉동 깐새우 감바스', price: 16900, image: 'http://shop1.phinf.naver.net/20190409_224/kp6011_1554790544893inNIP_JPEG/37421724544940437_11654507.jpg', keywords: ['생새우', '새우', '칵테일새우'] },
      { id: 2987384633, name: '고등어밥상 오렌지라벨 순살 뼈 없는 노르웨이 고등어 550g', price: 18900, image: 'http://shop1.phinf.naver.net/20260406_66/1775432323250d6fyE_JPEG/90440817211799835_1371186701.jpg', keywords: ['고등어', '순살고등어', '가시제거고등어'] },
      { id: 2987275090, name: '가시제거연구소 순살 고등어 구이 70g 덮밥 즉석 간편 생선구이', price: 16500, image: 'http://shop1.phinf.naver.net/20220124_2/16429852648092uIkj_JPEG/44121048346872075_508219543.jpg', keywords: ['순살고등어', '고등어구이', '전자렌지고등어'] },
      { id: 685814619, name: '고등어밥상 550g 순살 가시 뼈 없는 노르웨이 고등어 가시제거연구소', price: 17900, image: 'http://shop1.phinf.naver.net/20260406_101/1775432262696hmBV9_JPEG/68157380994703236_1801102520.jpg', keywords: ['고등어', '순살고등어', '노르웨이고등어'] }
    ];

    products.forEach(product => {
      const productResult = run(
        "INSERT INTO products (product_name, product_url, thumbnail_url, price, review_count, store_name, catalog_id) VALUES (?, ?, ?, ?, 0, '가시제거연구소', ?)",
        [product.name, `https://brand.naver.com/koreapelagic/products/${product.id}`, product.image, product.price, product.catalogId || null]
      );

      const productId = productResult.lastInsertRowid;
      product.keywords.forEach(keyword => {
        run('INSERT INTO keywords (product_id, keyword, is_auto_extracted) VALUES (?, ?, 1)', [productId, keyword]);
      });
    });

    console.log('[Seed] ✅ 40개 상품 및 키워드 등록 완료');
  }
}

// ============================================================
// 서버 시작 (비동기 DB 초기화 후)
// ============================================================
async function startServer() {
  await initDB();

  seedDefaultData();

  app.listen(PORT, () => {
    console.log(`\n🐟 가시제거연구소 순위 트래커 서버 시작!`);
    console.log(`📡 http://localhost:${PORT}`);
    console.log(`─────────────────────────────────────`);

    startScheduler();
  });
}

startServer().catch(err => {
  console.error('서버 시작 실패:', err);
  process.exit(1);
});
