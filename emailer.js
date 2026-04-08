const nodemailer = require('nodemailer');

/**
 * 이메일 알림 모듈
 * Gmail 앱 비밀번호 사용 권장
 */

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

/**
 * 순위 변동 알림 이메일 발송
 * @param {Object} alertData - 알림 데이터
 * @param {string} recipientEmail - 수신자 이메일
 */
async function sendRankingAlert(alertData, recipientEmail) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('[Email] 이메일 설정이 없어 알림을 건너뜁니다.');
    return { success: false, reason: 'Email not configured' };
  }

  const transporter = createTransporter();

  const { productName, keyword, previousRank, currentRank, changeAmount, direction } = alertData;

  const isDropped = direction === 'down';
  const emoji = isDropped ? '📉' : '📈';
  const color = isDropped ? '#e74c3c' : '#27ae60';
  const dirText = isDropped ? '하락' : '상승';

  const htmlBody = `
    <div style="font-family: 'Pretendard', 'Apple SD Gothic Neo', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px 12px 0 0;">
        <h2 style="margin: 0;">${emoji} 순위 변동 알림</h2>
        <p style="margin: 5px 0 0; opacity: 0.9;">가시제거연구소 순위 트래커</p>
      </div>

      <div style="background: #fff; border: 1px solid #e0e0e0; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #666;">상품명</td>
            <td style="padding: 8px 0; font-weight: bold;">${productName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">키워드</td>
            <td style="padding: 8px 0; font-weight: bold;">"${keyword}"</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">이전 순위</td>
            <td style="padding: 8px 0;">${previousRank ? previousRank + '위' : '기록 없음'}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">현재 순위</td>
            <td style="padding: 8px 0; font-weight: bold; color: ${color}; font-size: 18px;">
              ${currentRank ? currentRank + '위' : '순위권 밖'}
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">변동</td>
            <td style="padding: 8px 0; color: ${color}; font-weight: bold;">
              ${emoji} ${changeAmount}단계 ${dirText}
            </td>
          </tr>
        </table>

        <div style="margin-top: 20px; padding: 12px; background: #f8f9fa; border-radius: 8px; font-size: 13px; color: #666;">
          이 알림은 순위 트래커에서 자동 발송되었습니다.<br>
          알림 설정은 대시보드에서 변경할 수 있습니다.
        </div>
      </div>
    </div>
  `;

  try {
    const info = await transporter.sendMail({
      from: `"가시제거연구소 순위트래커" <${process.env.EMAIL_USER}>`,
      to: recipientEmail,
      subject: `${emoji} [순위${dirText}] ${productName} - "${keyword}" ${currentRank || '순위권 밖'}위 (${changeAmount}단계 ${dirText})`,
      html: htmlBody,
    });

    console.log(`[Email] 알림 발송 완료: ${info.messageId}`);
    return { success: true, messageId: info.messageId };

  } catch (error) {
    console.error('[Email] 발송 실패:', error.message);
    return { success: false, reason: error.message };
  }
}

/**
 * 일일 리포트 이메일 발송
 * @param {Array} rankingResults - 전체 순위 결과 배열
 * @param {string} recipientEmail - 수신자 이메일
 */
async function sendDailyReport(rankingResults, recipientEmail) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('[Email] 이메일 설정이 없어 리포트를 건너뜁니다.');
    return { success: false, reason: 'Email not configured' };
  }

  const transporter = createTransporter();
  const today = new Date().toLocaleDateString('ko-KR');

  const rows = rankingResults.map(r => `
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">${r.productName}</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">${r.keyword}</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold; text-align: center;">
        ${r.rank ? r.rank + '위' : '-'}
      </td>
      <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: center; color: ${r.change > 0 ? '#e74c3c' : r.change < 0 ? '#27ae60' : '#666'};">
        ${r.change > 0 ? '▼' + r.change : r.change < 0 ? '▲' + Math.abs(r.change) : '-'}
      </td>
    </tr>
  `).join('');

  const htmlBody = `
    <div style="font-family: 'Pretendard', 'Apple SD Gothic Neo', sans-serif; max-width: 700px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px 12px 0 0;">
        <h2 style="margin: 0;">📊 일일 순위 리포트</h2>
        <p style="margin: 5px 0 0; opacity: 0.9;">${today} | 가시제거연구소</p>
      </div>
      <div style="background: #fff; border: 1px solid #e0e0e0; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #f8f9fa;">
              <th style="padding: 10px; text-align: left;">상품</th>
              <th style="padding: 10px; text-align: left;">키워드</th>
              <th style="padding: 10px; text-align: center;">순위</th>
              <th style="padding: 10px; text-align: center;">변동</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;

  try {
    const info = await transporter.sendMail({
      from: `"가시제거연구소 순위트래커" <${process.env.EMAIL_USER}>`,
      to: recipientEmail,
      subject: `📊 [일일리포트] 가시제거연구소 순위 현황 - ${today}`,
      html: htmlBody,
    });

    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('[Email] 리포트 발송 실패:', error.message);
    return { success: false, reason: error.message };
  }
}

module.exports = { sendRankingAlert, sendDailyReport };
