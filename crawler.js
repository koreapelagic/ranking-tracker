/**
 * 네이버 쇼핑 순위 크롤러 v11
 * ★ 상품번호/카탈로그 우선, 유사도는 최후 보루 (100% 정확도)
 * - 1순위: 카탈로그 ID 매칭 (네이버 카탈로그 묶음 상품)
 * - 2순위: 상품번호(productId) 직접 매칭 (link URL 내 상품번호)
 * - 3순위: 스토어명 + 상품명 유사도 (임계값 0.8, 핵심토큰 필수)
 */

const axios = require('axios');

const NAVER_CLIENT_ID = () => process.env.NAVER_CLIENT_ID || '';
const NAVER_CLIENT_SECRET = () => process.env.NAVER_CLIENT_SECRET || '';

/**
 * 상품명 유사도 계산 — 양방향 토큰 매칭 + 핵심토큰 필수
 * @returns { score: 0~1, coreMatch: boolean }
 */
function calcSimilarity(searchTitle, dbProductName) {
  const clean = s => (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const a = clean(searchTitle);
  const b = clean(dbProductName);

  if (!a || !b) return { score: 0, coreMatch: false };
  if (a === b) return { score: 1.0, coreMatch: true };
  if (a.includes(b) || b.includes(a)) return { score: 0.95, coreMatch: true };

  const tokenize = s => {
    return s
      .replace(/[^\uAC00-\uD7A3a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2);
  };

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensB.length === 0) return { score: 0, coreMatch: false };

  // ★ 핵심토큰: 용량 + 라벨/구분자 — 양방향 체크
  // "칵테일새우 200g" vs "칵테일새우 900g" → 용량 불일치 → 거부
  // "오렌지라벨 550g" vs "550g (라벨없음)" → 검색결과의 라벨이 DB에 없음 → 거부
  const labelTokens = ['핑크라벨', '오렌지라벨', '네이버라벨', '콤보', '새콤60', '제로새우', '노바시'];

  // DB 상품명 핵심토큰
  const coreB = [];
  const volB = b.match(/\d+\s*(?:g|kg|ml|l|미|개|팩|세트)\b/gi) || [];
  volB.forEach(v => coreB.push(v.replace(/\s/g, '').toLowerCase()));
  for (const lt of labelTokens) { if (b.includes(lt)) coreB.push(lt); }

  // 검색결과 핵심토큰
  const coreA = [];
  const volA = a.match(/\d+\s*(?:g|kg|ml|l|미|개|팩|세트)\b/gi) || [];
  volA.forEach(v => coreA.push(v.replace(/\s/g, '').toLowerCase()));
  for (const lt of labelTokens) { if (a.includes(lt)) coreA.push(lt); }

  // 양방향 체크: DB핵심→검색결과 AND 검색결과핵심→DB
  let coreMatch = true;
  // DB 핵심토큰이 검색결과에 모두 있어야 함
  for (const ct of coreB) {
    if (!a.includes(ct)) { coreMatch = false; break; }
  }
  // 검색결과 핵심토큰(라벨)이 DB에도 있어야 함 (라벨만 — 용량은 위에서 이미 체크)
  if (coreMatch) {
    for (const ct of coreA) {
      if (labelTokens.includes(ct) && !b.includes(ct)) { coreMatch = false; break; }
    }
  }
  // 용량이 양쪽 다 있으면 반드시 일치해야 함
  if (coreMatch && volA.length > 0 && volB.length > 0) {
    const normVols = vs => vs.map(v => v.replace(/\s/g, '').toLowerCase()).sort().join(',');
    if (normVols(volA) !== normVols(volB)) {
      // 하나라도 겹치는지 확인 (다중 용량 상품)
      const setA = new Set(volA.map(v => v.replace(/\s/g, '').toLowerCase()));
      const setB = new Set(volB.map(v => v.replace(/\s/g, '').toLowerCase()));
      const overlap = [...setA].some(v => setB.has(v));
      if (!overlap) coreMatch = false;
    }
  }

  // DB 상품명 토큰이 검색결과에 포함되는 비율
  let matchB = 0;
  for (const tb of tokensB) {
    if (tokensA.some(ta => ta === tb || ta.includes(tb) || tb.includes(ta))) matchB++;
  }
  const scoreB = matchB / tokensB.length;

  // 검색결과 토큰이 DB 상품명에 포함되는 비율 (역방향도 체크)
  let matchA = 0;
  for (const ta of tokensA) {
    if (tokensB.some(tb => tb === ta || tb.includes(ta) || ta.includes(tb))) matchA++;
  }
  const scoreA = tokensA.length > 0 ? matchA / tokensA.length : 0;

  // 양방향 평균 (F1 score 방식)
  const score = (scoreA + scoreB) / 2;
  return { score, coreMatch };
}

/**
 * URL에서 상품번호 추출
 */
function extractProductNumber(url) {
  if (!url) return null;
  // brand.naver.com/.../products/XXXXX
  const m1 = url.match(/products\/(\d+)/);
  if (m1) return m1[1];
  // smartstore.naver.com/.../products/XXXXX
  const m2 = url.match(/\/(\d{5,})/);
  if (m2) return m2[1];
  return null;
}

/**
 * 네이버 쇼핑 검색 API로 순위 조회
 * ★ productUrl로 정확 매칭 → 카탈로그 ID 매칭 → 엄격 유사도 매칭
 */
async function searchRanking(keyword, storeName = '가시제거연구소', productName = '', maxPages = 3, catalogId = null, productUrl = '') {
  const clientId = NAVER_CLIENT_ID();
  const clientSecret = NAVER_CLIENT_SECRET();

  if (!clientId || !clientSecret) {
    return { rank: null, page: null, totalResults: 0, productInfo: null, message: 'API 키 없음' };
  }

  // DB에 저장된 상품번호 추출
  const myProductNum = extractProductNumber(productUrl);

  console.log(`  [크롤러v11] 검색: "${keyword}" → "${productName.substring(0, 35)}..." ${catalogId ? `[카탈로그:${catalogId}]` : ''} ${myProductNum ? `[상품번호:${myProductNum}]` : ''}`);

  try {
    const candidates = [];

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const start = (pageNum - 1) * 100 + 1;

      const response = await axios.get('https://openapi.naver.com/v1/search/shop.json', {
        params: { query: keyword, display: 100, start, sort: 'sim' },
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        },
        timeout: 10000,
      });

      const items = response.data.items || [];
      const totalResults = response.data.total || 0;

      if (items.length === 0) break;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const rank = start + i;
        const cleanTitle = (item.title || '').replace(/<[^>]*>/g, '');
        const itemProdId = (item.productId || '').toString();
        const itemLink = item.link || '';
        const itemProductNum = extractProductNumber(itemLink);

        // ★ 매칭 방법 1: 카탈로그 ID 직접 매칭 (가장 정확)
        if (catalogId && itemProdId === catalogId.toString()) {
          candidates.push({
            rank, page: pageNum, totalResults,
            matchType: 'CATALOG_ID',
            similarity: 1.0,
            item: { title: cleanTitle, price: parseInt(item.lprice) || 0, image: item.image || '', mallName: item.mallName || '', productId: itemProdId, link: itemLink },
          });
          continue;
        }

        // ★ 매칭 방법 2: 상품번호(URL) 직접 매칭
        if (myProductNum && itemProductNum && myProductNum === itemProductNum) {
          candidates.push({
            rank, page: pageNum, totalResults,
            matchType: 'PRODUCT_NUM',
            similarity: 1.0,
            item: { title: cleanTitle, price: parseInt(item.lprice) || 0, image: item.image || '', mallName: item.mallName || '', productId: itemProdId, link: itemLink },
          });
          continue;
        }

        // ★ 매칭 방법 3: 스토어명 + 상품명 유사도 (엄격 — 핵심토큰 필수)
        const mallName = (item.mallName || '').toLowerCase();
        const isStore =
          mallName.includes('가시제거') ||
          mallName.includes('koreapelagic') ||
          mallName.includes('가시제거연구소');

        if (isStore) {
          const { score, coreMatch } = calcSimilarity(cleanTitle, productName);
          candidates.push({
            rank, page: pageNum, totalResults,
            matchType: 'SIMILARITY',
            similarity: score,
            coreMatch,
            item: { title: cleanTitle, price: parseInt(item.lprice) || 0, image: item.image || '', mallName: item.mallName || '', productId: itemProdId, link: itemLink },
          });
        }
      }

      // 카탈로그 또는 상품번호로 정확 매칭된 게 있으면 더 이상 페이지 안 넘김
      if (candidates.some(c => c.matchType === 'CATALOG_ID' || c.matchType === 'PRODUCT_NUM')) break;

      if (start + items.length > totalResults) break;
      await new Promise(r => setTimeout(r, 200));
    }

    // 최적 후보 선택 (매칭 우선순위: CATALOG_ID > PRODUCT_NUM > SIMILARITY)
    if (candidates.length > 0) {
      const priority = { CATALOG_ID: 0, PRODUCT_NUM: 1, SIMILARITY: 2 };

      // 1. 정확 매칭(CATALOG/PRODUCT_NUM) 우선
      const exactMatches = candidates.filter(c => c.matchType !== 'SIMILARITY');
      if (exactMatches.length > 0) {
        const bestMatch = exactMatches.sort((a, b) => priority[a.matchType] - priority[b.matchType] || a.rank - b.rank)[0];
        console.log(`  [크롤러v11] ✅ ${bestMatch.rank}위 [${bestMatch.matchType}] "${bestMatch.item.title.substring(0, 40)}"`);
        return buildResult(bestMatch, keyword, candidates.length);
      }

      // 2. 유사도 매칭 — 임계값 0.8 이상 + 핵심토큰 일치 필수
      const goodMatches = candidates
        .filter(c => c.similarity >= 0.8 && c.coreMatch !== false)
        .sort((a, b) => b.similarity - a.similarity || a.rank - b.rank);

      if (goodMatches.length > 0) {
        const bestMatch = goodMatches[0];
        console.log(`  [크롤러v11] ✅ ${bestMatch.rank}위 [유사도${(bestMatch.similarity*100).toFixed(0)}%+핵심O] "${bestMatch.item.title.substring(0, 40)}"`);
        if (candidates.length > 1) {
          console.log(`  [크롤러v11]    후보 ${candidates.length}개: ${candidates.slice(0, 5).map(c => `${c.rank}위(${(c.similarity*100).toFixed(0)}%,핵심${c.coreMatch?'O':'X'})`).join(', ')}`);
        }
        return buildResult(bestMatch, keyword, candidates.length);
      }

      // 3. 유사도 또는 핵심토큰 부족 — 매칭 거부
      const simCandidates = candidates.filter(c => c.matchType === 'SIMILARITY');
      console.log(`  [크롤러v11] ⚠️ 스토어 내 ${simCandidates.length}개 발견되었으나 매칭 조건 미달:`);
      simCandidates.slice(0, 5).forEach(c => {
        console.log(`    ${c.rank}위 (${(c.similarity*100).toFixed(0)}%, 핵심${c.coreMatch?'O':'X'}) "${c.item.title.substring(0, 50)}"`);
      });
      console.log(`    → DB 상품명: "${productName.substring(0, 50)}"`);
      const best = simCandidates.sort((a, b) => b.similarity - a.similarity)[0];
      return { rank: null, page: null, totalResults: best?.totalResults || 0, productInfo: null, message: `매칭조건 미달 (유사도${(best?.similarity*100||0).toFixed(0)}%, 핵심토큰${best?.coreMatch?'일치':'불일치'})` };
    }

    // 못 찾음
    console.log(`  [크롤러v11] ❌ 300위 내 미발견: "${keyword}"`);
    return { rank: null, page: null, totalResults: 0, productInfo: null, message: `"${keyword}" 300위 내 미발견` };

  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      if (status === 401) return { rank: null, message: 'API 인증 실패' };
      if (status === 429) return { rank: null, message: 'API 한도 초과' };
    }
    console.error(`  [크롤러v11] ❌ 에러:`, error.message);
    return { rank: null, message: '검색 실패: ' + error.message };
  }
}

function buildResult(match, keyword, candidateCount) {
  // 카탈로그 묶음 감지: 상품명 앞에 "코리아펠라직" 포함 여부
  const isCatalog = /^코리아펠라직/i.test(match.item.title.trim());
  return {
    found: true,
    rank: match.rank,
    page: match.page,
    totalResults: match.totalResults,
    isCatalog,
    productInfo: {
      ...match.item,
      reviewCount: 0,
    },
    debug: { method: `NAVER_API_v11_${match.matchType}`, keyword, candidates: candidateCount, similarity: match.similarity },
  };
}

/**
 * 스마트스토어 상품 URL에서 상품 정보 추출
 */
async function fetchProductInfo(productUrl) {
  try {
    const response = await axios.get(productUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      timeout: 10000,
    });

    const html = response.data;
    const getMeta = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'));
      return m ? m[1] : '';
    };

    return {
      name: getMeta('og:title') || '',
      price: parseInt(getMeta('product:price:amount')) || 0,
      image: getMeta('og:image') || '',
      reviewCount: 0,
    };
  } catch (error) {
    console.error('[ProductInfo] 실패:', error.message);
    return null;
  }
}

function extractKeywords(productName) {
  const stopWords = [
    '무료배송', '당일발송', '특가', '할인', '세일', '이벤트',
    '개', '팩', '세트', '박스', 'g', 'kg', 'ml',
    '의', '를', '을', '이', '가', '에', '로', '와', '과',
    '프리미엄', '국내산', '수입산', '냉동', '냉장', '진공', '포장',
  ];

  let cleaned = productName
    .replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '')
    .replace(/[^가-힣a-zA-Z0-9\s]/g, ' ')
    .replace(/\d+[gkgmlLeaEA팩개입세트박스]+/gi, '')
    .replace(/\s+/g, ' ').trim();

  let words = cleaned.split(' ').filter(w => w.length >= 2 && !stopWords.includes(w));
  const keywords = [];
  if (words.length >= 2) keywords.push(words.slice(0, 3).join(' '));
  if (words.length >= 2) keywords.push(words.slice(0, 2).join(' '));
  if (words.length >= 3) keywords.push(words[0] + ' ' + words[2]);

  const unique = [...new Set(keywords)].slice(0, 3);
  while (unique.length < 3 && words.length > 0) {
    const w = words.shift();
    if (!unique.some(k => k.includes(w))) unique.push(w);
  }
  return unique.slice(0, 3);
}

async function closeBrowser() {}

module.exports = { searchRanking, fetchProductInfo, extractKeywords, closeBrowser, calcSimilarity };
