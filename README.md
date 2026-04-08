# 🐟 가시제거연구소 네이버 쇼핑 순위 트래커

네이버 지식쇼핑에서 가시제거연구소 상품의 키워드별 순위를 자동으로 추적하는 대시보드입니다.

## 빠른 시작

```bash
# 1. 프로젝트 폴더로 이동
cd ranking-tracker

# 2. 의존성 설치
npm install

# 3. 환경설정 (이메일 알림을 쓸 경우)
cp .env.example .env
# .env 파일을 열어 이메일 설정을 입력하세요

# 4. 서버 실행
npm start
```

브라우저에서 **http://localhost:3000** 접속

## 주요 기능

### 📊 대시보드
- 상품별 키워드 순위를 카드 형태로 한눈에 확인
- 순위 변동 (▲상승 / ▼하락) 실시간 표시
- 상품명, 썸네일, 가격, 리뷰 수, 순위를 함께 표시

### 🔍 순위 조회
- 개별 키워드 수동 순위 체크 (🔍 버튼)
- 전체 키워드 일괄 순위 체크
- 매일 오전 8시 자동 순위 체크 (크론 스케줄러)

### ➕ 상품/키워드 관리
- **URL 자동 추출**: 스마트스토어 URL 입력 → 상품명 + 키워드 3개 자동 추출
- **직접 입력**: 상품명과 키워드를 수동 등록
- 상품당 키워드 최대 5개 (자동 3개 + 수동 2개)

### 🔔 이메일 알림
- On/Off 토글로 간편 설정
- 순위 변동 민감도 조절 (±1~20단계)
- 순위 급변 시 즉시 알림 + 일일 리포트 발송

## 이메일 알림 설정 (Gmail)

1. Google 계정 → [앱 비밀번호](https://myaccount.google.com/apppasswords) 생성
2. `.env` 파일에 입력:
```
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=생성된-앱-비밀번호
EMAIL_TO=알림받을-이메일@gmail.com
```

## 기술 스택
- **Backend**: Node.js + Express
- **Database**: SQLite (sql.js)
- **Frontend**: React 18 + Vanilla CSS
- **Crawler**: Axios + Cheerio (네이버 쇼핑 API/HTML 파싱)
- **Scheduler**: node-cron
- **Email**: Nodemailer

## 배포 방법

### Railway / Render (추천)
1. GitHub에 코드 푸시
2. Railway 또는 Render에서 프로젝트 연결
3. 환경변수 설정 후 배포

### 로컬 상시 실행 (PM2)
```bash
npm install -g pm2
pm2 start server.js --name "ranking-tracker"
pm2 save
pm2 startup
```
