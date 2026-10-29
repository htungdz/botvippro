const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class Engine {
    constructor() {
        this.history = [];          // 'T' / 'X'
        this.detailedHistory = [];  // tong diem nut
        this.models = {};
        this.weights = {};
        this.lastPredictions = {};
        this.consecutiveLosses = 0;

        this.sessionStats = {
            streaks: { T: 0, X: 0, maxT: 0, maxX: 0 },
            transitions: { TtoT: 0, TtoX: 0, XtoT: 0, XtoX: 0 },
            volatility: 0.5,
            recentAccuracy: 0,
            sumAverage: 10.5
        };
        this.marketState = { trend: 'CÂN BẰNG', regime: 'NORMAL' };

        // ===== SIÊU VIP ENGINE UPGRADE =====
        this.modelHits = {};        // EWMA do chinh xac tung model
        this.autocorr = 0;          // tu tuong quan lag-1 (+1: bet, -1: nhip)
        this.entropy = 1.0;
        this.streakSurvival = {};   // P(tiep tuc | do dai chuoi k) thuc nghiem
        this.balancedLastPreds = []; // model19 — chống bệt dự đoán
        this.initAllModels();
    }

    initAllModels() {
        for (let i = 1; i <= 10; i++) {
            if (this[`model${i}`]) {
                this.models[`model${i}`] = this[`model${i}`].bind(this);
                this.weights[`model${i}`] = i === 1 ? 0.08 : 1.0;
                this.modelHits[`model${i}`] = { win: 0, loss: 0, ewma: 0.5 };
            }
        }
        this.models['model_antiBreak'] = this.model_antiBreak.bind(this);
        this.weights['model_antiBreak'] = 1.7;
        this.modelHits['model_antiBreak'] = { win: 0, loss: 0, ewma: 0.5 };
        for (let i = 11; i <= 25; i++) {
            if (this[`model${i}`]) {
                this.models[`model${i}`] = this[`model${i}`].bind(this);
                this.weights[`model${i}`] = 1.0;
                this.modelHits[`model${i}`] = { win: 0, loss: 0, ewma: 0.5 };
            }
        }
        // Pattern-8 lookup weight hơi cao vì bảng thực nghiệm
        // SIÊU NÂNG CẤP trọng số model 16-25 + antiBreak
        if (this.models['model16']) this.weights['model16'] = 1.55;
        if (this.models['model17']) this.weights['model17'] = 0.85;
        if (this.models['model18']) this.weights['model18'] = 1.30;
        if (this.models['model19']) this.weights['model19'] = 1.20;
        if (this.models['model20']) this.weights['model20'] = 1.55;
        if (this.models['model21']) this.weights['model21'] = 1.65;
        if (this.models['model_antiBreak']) this.weights['model_antiBreak'] = 1.95;
        if (this.models['model22']) this.weights['model22'] = 1.35;
        if (this.models['model23']) this.weights['model23'] = 1.25;
        if (this.models['model24']) this.weights['model24'] = 0.95;
        if (this.models['model25']) this.weights['model25'] = 1.30;
    }

    addResult(result, diceSum = null) {
        // Cap nhat trong so adaptive + EWMA do chinh xac tung model
        for (const [modelName, lastPred] of Object.entries(this.lastPredictions)) {
            if (lastPred && lastPred.prediction) {
                const hit = lastPred.prediction === result;
                if (hit) {
                    this.weights[modelName] = Math.min((this.weights[modelName] || 1.0) * 1.12, 3.5);
                } else {
                    const penalty = (modelName === 'model1' || modelName === 'model_antiBreak') ? 0.40 : 0.70;
                    this.weights[modelName] = Math.max((this.weights[modelName] || 1.0) * penalty, 0.05);
                }
                if (this.modelHits[modelName]) {
                    const h = this.modelHits[modelName];
                    if (hit) h.win++; else h.loss++;
                    h.ewma = 0.82 * h.ewma + 0.18 * (hit ? 1 : 0);
                }
            }
        }
        this.lastPredictions = {};

        if (this.history.length > 0) {
            const lastResult = this.history[this.history.length - 1];
            const transitionKey = `${lastResult}to${result}`;
            this.sessionStats.transitions[transitionKey] = (this.sessionStats.transitions[transitionKey] || 0) + 1;

            if (result === lastResult) {
                this.sessionStats.streaks[result]++;
                this.sessionStats.streaks[`max${result}`] = Math.max(
                    this.sessionStats.streaks[`max${result}`],
                    this.sessionStats.streaks[result]
                );
            } else {
                this.sessionStats.streaks[result] = 1;
                this.sessionStats.streaks[lastResult] = 0;
            }
        } else {
            this.sessionStats.streaks[result] = 1;
        }

        this.history.push(result);
        if (diceSum !== null) {
            this.detailedHistory.push(diceSum);
            if (this.detailedHistory.length > 200) this.detailedHistory.shift();
            const recentSums = this.detailedHistory.slice(-15);
            this.sessionStats.sumAverage = recentSums.reduce((a, b) => a + b, 0) / recentSums.length;
        }
        if (this.history.length > 300) this.history.shift();

        this.updateVolatility();
        this.updateAutocorrelation();
        this.updateStreakSurvival();
        this.updateMarketState();
    }

    updateVolatility() {
        if (this.history.length < 5) return;
        const recent = this.history.slice(-10);
        let changes = 0;
        for (let i = 1; i < recent.length; i++) {
            if (recent[i] !== recent[i-1]) changes++;
        }
        this.sessionStats.volatility = changes / (recent.length - 1);
        // Shannon entropy 20 phien gan nhat
        const w = this.history.slice(-20);
        const pT = w.filter(c => c === 'T').length / Math.max(1, w.length);
        const pX = 1 - pT;
        const e = -(pT > 0 ? pT * Math.log2(pT) : 0) - (pX > 0 ? pX * Math.log2(pX) : 0);
        this.entropy = isNaN(e) ? 1 : e;
    }

    updateAutocorrelation() {
        const N = Math.min(this.history.length, 40);
        if (N < 8) { this.autocorr = 0; return; }
        const seq = this.history.slice(-N).map(c => c === 'T' ? 1 : -1);
        const mean = seq.reduce((a, b) => a + b, 0) / seq.length;
        let num = 0, den = 0;
        for (let i = 1; i < seq.length; i++) {
            num += (seq[i-1] - mean) * (seq[i] - mean);
            den += (seq[i] - mean) * (seq[i] - mean);
        }
        this.autocorr = den > 0 ? Math.max(-0.9, Math.min(0.9, num / den)) : 0;
    }

    updateStreakSurvival() {
        // P(chuoi tiep tuc | da chay k phien) — thuc nghiem tren toan bo lich su
        const cont = {}, tot = {};
        let runChar = null, runLen = 0;
        for (let i = 0; i < this.history.length; i++) {
            const c = this.history[i];
            if (runChar === c) {
                const k = Math.min(runLen, 8);
                tot[k] = (tot[k] || 0) + 1;
                cont[k] = (cont[k] || 0) + 1;
                runLen++;
            } else {
                if (runChar !== null) {
                    const k = Math.min(runLen, 8);
                    tot[k] = (tot[k] || 0) + 1; // chuoi do dai k bi be
                }
                runChar = c;
                runLen = 1;
            }
        }
        this.streakSurvival = {};
        for (const k in tot) {
            this.streakSurvival[k] = ((cont[k] || 0) + 0.5) / (tot[k] + 1.0); // Laplace smoothing
        }
    }

    updateMarketState() {
        if (this.history.length < 10) return;
        const recent = this.history.slice(-15);
        const tCount = recent.filter(x => x === 'T').length;
        const xCount = recent.filter(x => x === 'X').length;
        const diff = Math.abs(tCount - xCount) / recent.length;

        if (this.autocorr < -0.18 || this.sessionStats.volatility > 0.7) {
            this.marketState.regime = 'Cầu Nhịp Ngắn (1-1 / 1-2)';
        } else if (diff > 0.4) {
            this.marketState.regime = tCount > xCount ? 'Cầu Nghiêng TÀI' : 'Cầu Nghiêng XỈU';
        } else if (this.sessionStats.streaks.T >= 3 || this.sessionStats.streaks.X >= 3) {
            this.marketState.regime = 'Cầu Bệt / Chuỗi Dài';
        } else {
            this.marketState.regime = 'Cầu Tách / Khuôn 2-2';
        }
        this.marketState.trend = tCount > xCount ? 'TÀI TẮC' : (xCount > tCount ? 'XỈU TẮC' : 'CÂN BẰNG');
    }

    // ===== CÁC MODEL DỰ ĐOÁN (giữ nguyên tên, nâng cấp logic) =====

    // Model 1: SIÊU KHÓ bắt 1-1 — chỉ khi ≥12 phiên đan xen sạch (mọi phiên đều flip)
    model1() {
        const recent = this.history.slice(-14);
        if (recent.length < 12) return null;
        let flips = 0;
        for (let i = 1; i < recent.length; i++) if (recent[i] !== recent[i - 1]) flips++;
        // phải gần như 100% flip (cho phép tối đa 1 lần không flip)
        if (flips < recent.length - 2) return null;
        // kiểm tra RLE: nếu có đoạn ≥2 thì không phải 1-1
        let run = 1, maxRun = 1;
        for (let i = 1; i < recent.length; i++) {
            if (recent[i] === recent[i-1]) { run++; maxRun = Math.max(maxRun, run); }
            else run = 1;
        }
        if (maxRun >= 2) return null;
        const last = recent[recent.length - 1];
        const pred = last === 'T' ? 'X' : 'T';
        return { prediction: pred, confidence: 0.48, reason: `1-1 sạch ${recent.length} phiên (hiếm) → đảo nhẹ` };
    }

    // Model Anti-Break: dung hazard thuc nghiem cua chuoi
    model_antiBreak() {
        const last = this.history[this.history.length - 1];
        if (!last) return null;
        const streak = this.sessionStats.streaks[last] || 0;
        if (streak < 2) return null;
        const k = Math.min(streak, 8);
        const surv = this.streakSurvival[k];
        if (surv === undefined) {
            if (streak >= 2 && streak <= 5) {
                return { prediction: last, confidence: 0.85 + (streak * 0.02), reason: `Anti Bẻ Cầu: Chuỗi ${streak} (${last === 'T' ? 'TÀI' : 'XỈU'})` };
            }
            return null;
        }
        if (surv >= 0.52) {
            const conf = Math.min(0.6 + (surv - 0.5) * 1.5, 0.9);
            return { prediction: last, confidence: conf, reason: `Anti-Bẻ Thực Nghiệm: P(tiếp tục)=${(surv * 100).toFixed(0)}% @ chuỗi ${streak}` };
        } else if (surv <= 0.45) {
            const conf = Math.min(0.6 + (0.5 - surv) * 1.5, 0.9);
            return { prediction: last === 'T' ? 'X' : 'T', confidence: conf, reason: `Hazard Bẻ Cầu: P(đứt)=${((1 - surv) * 100).toFixed(0)}% @ chuỗi ${streak}` };
        }
        return null;
    }

    // Model 2: Bet dai — ket hop hazard thuc nghiem
    model2() {
        const last = this.history[this.history.length - 1];
        if (!last) return null;
        const streak = this.sessionStats.streaks[last] || 0;
        if (streak < 3) return null;
        const k = Math.min(streak, 8);
        const surv = this.streakSurvival[k];
        if (surv !== undefined) {
            if (streak <= 6 && surv >= 0.5) {
                return { prediction: last, confidence: Math.min(0.7 + surv * 0.2, 0.9), reason: `Cầu Bệt ${streak} Phiên (Hazard ${(surv * 100).toFixed(0)}% tiếp)` };
            }
            if (streak > 6 || surv < 0.42) {
                return { prediction: last === 'T' ? 'X' : 'T', confidence: 0.72, reason: `Cầu Quá Dài (${streak} Phiên) - Bẻ An Toàn` };
            }
            return null;
        }
        if (streak >= 3 && streak <= 6) return { prediction: last, confidence: 0.82, reason: `Cầu Bệt Dài ${streak} Phiên (Xu Hướng Trôi)` };
        if (streak > 6) return { prediction: last === 'T' ? 'X' : 'T', confidence: 0.70, reason: `Cầu Quá Dài (${streak} Phiên) - Bẻ An Toàn` };
        return null;
    }

    // Model 3: Khuon 2-2 / 3-1 — mo rong them mau
    model3() {
        const recent = this.history.slice(-4);
        if (recent.length < 4) return null;
        const str = recent.join('-');
        const map = {
            'T-T-X-X': { p: 'T', c: 0.80, r: 'Khuôn Cầu Đôi 2-2 (Ưu Tiên TÀI)' },
            'X-X-T-T': { p: 'X', c: 0.80, r: 'Khuôn Cầu Đôi 2-2 (Ưu Tiên XỈU)' },
            'T-X-X-T': { p: 'T', c: 0.76, r: 'Khuôn Cầu Kép 2-1-2' },
            'X-T-T-X': { p: 'X', c: 0.76, r: 'Khuôn Cầu Kép 2-1-2' },
            'T-T-T-X': { p: 'T', c: 0.70, r: 'Mẫu Cầu 3-1 (Lệch Pha)' },
            'X-X-X-T': { p: 'X', c: 0.70, r: 'Mẫu Cầu 3-1 (Lệch Pha)' },
            'T-X-T-T': { p: 'T', c: 0.68, r: 'Mẫu 1-2-1 Kéo Dài' },
            'X-T-X-X': { p: 'X', c: 0.68, r: 'Mẫu 1-2-1 Kéo Dài' }
        };
        const m = map[str];
        if (m) return { prediction: m.p, confidence: m.c, reason: m.r };
        return null;
    }

    // Model 4: Mau 1-2-1 tren 5 diem (tranh xung dot voi model3)
    model4() {
        const recent = this.history.slice(-5);
        if (recent.length < 5) return null;
        const str = recent.join('-');
        if (str === 'T-X-X-T-T') return { prediction: 'X', confidence: 0.74, reason: 'Cầu Tách Mẫu 1-2-1-1 (Hồi XỈU)' };
        if (str === 'X-T-T-X-X') return { prediction: 'T', confidence: 0.74, reason: 'Cầu Tách Mẫu 1-2-1-1 (Hồi TÀI)' };
        if (str === 'T-T-X-X-T') return { prediction: 'X', confidence: 0.72, reason: 'Mẫu 2-2-1 Đảo Chiều' };
        if (str === 'X-X-T-T-X') return { prediction: 'T', confidence: 0.72, reason: 'Mẫu 2-2-1 Đảo Chiều' };
        return null;
    }

    // Model 5: Diem nut cuc han
    model5() {
        if (this.detailedHistory.length === 0) return null;
        const lastSum = this.detailedHistory[this.detailedHistory.length - 1];
        if (lastSum <= 4) return { prediction: 'T', confidence: 0.88, reason: `Nút Cực Thấp (${lastSum} Nút) - Hồi Quy TÀI` };
        if (lastSum >= 17) return { prediction: 'X', confidence: 0.88, reason: `Nút Cực Cao (${lastSum} Nút) - Hồi Quy XỈU` };
        return null;
    }

    // Model 6: Trung binh diem nut
    model6() {
        if (this.detailedHistory.length < 4) return null;
        const avg = this.sessionStats.sumAverage;
        if (avg > 11.8) {
            return { prediction: 'X', confidence: Math.min(0.65 + (avg - 10.5) * 0.08, 0.85), reason: `Điểm Trung Bình Cao (${avg.toFixed(1)}) - Ép XỈU` };
        } else if (avg < 9.2) {
            return { prediction: 'T', confidence: Math.min(0.65 + (10.5 - avg) * 0.08, 0.85), reason: `Điểm Trung Bình Thấp (${avg.toFixed(1)}) - Ép TÀI` };
        }
        return null;
    }

    // Model 7: Markov bac 1 tu ma tran chuyen trang thuc nghiem
    model7() {
        if (this.history.length < 12) return null;
        const tr = this.sessionStats.transitions;
        const last = this.history[this.history.length - 1];
        const other = last === 'T' ? 'X' : 'T';
        const cCont = tr[`${last}to${last}`] || 0;
        const cBreak = tr[`${last}to${other}`] || 0;
        const tot = cCont + cBreak;
        if (tot < 6) return null;
        const pCont = (cCont + 0.5) / (tot + 1);
        if (Math.abs(pCont - 0.5) < 0.08) return null;
        const pred = pCont > 0.5 ? last : other;
        const conf = Math.min(0.55 + Math.abs(pCont - 0.5) * 1.2, 0.85);
        return { prediction: pred, confidence: conf, reason: `Markov Bậc 1: P(${pred === 'T' ? 'TÀI' : 'XỈU'})=${(Math.max(pCont, 1 - pCont) * 100).toFixed(0)}% (${tot} mẫu)` };
    }

    // Model 8: N-gram Markov bac bien (2..5) co trong so thoi gian — model manh nhat
    model8() {
        if (this.history.length < 10) return null;
        const H = this.history;
        const hs = H.join('');
        let aggLo = 0, aggW = 0, bestOrder = 0, bestSupport = 0;
        for (let order = 2; order <= 5; order++) {
            if (H.length < order + 5) continue;
            const suffix = hs.slice(-order);
            let tW = 0, xW = 0, support = 0;
            for (let i = 0; i + order < H.length; i++) {
                if (hs.substr(i, order) !== suffix) continue;
                const recency = 0.35 + 0.65 * (i / (H.length - 1)); // mau gan nhat trong so cao hon
                if (H[i + order] === 'T') tW += recency; else xW += recency;
                support += recency;
            }
            if (support < 1.2) continue;
            const pT = (tW + 0.5) / (support + 1.0);
            const pc = Math.min(Math.max(pT, 0.12), 0.88);
            const lo = Math.log(pc / (1 - pc));
            const w = support * (1 + 0.12 * order); // bac cao hon duoc tin hon khi du mau
            aggLo += w * lo;
            aggW += w;
            if (support > bestSupport) { bestSupport = support; bestOrder = order; }
        }
        if (aggW === 0) return null;
        const pT = 1 / (1 + Math.exp(-aggLo));
        if (Math.abs(pT - 0.5) < 0.06) return null;
        const pred = pT > 0.5 ? 'T' : 'X';
        const conf = Math.min(0.55 + Math.abs(pT - 0.5) * 1.1, 0.9);
        return { prediction: pred, confidence: conf, reason: `N-gram Markov Bậc ${bestOrder} (${bestSupport.toFixed(1)} mẫu có trọng số)` };
    }

    // Model 9: Regime adapter dua tren tu tuong quan (bet vs nhip)
    model9() {
        if (this.history.length < 15) return null;
        const ac = this.autocorr;
        if (Math.abs(ac) < 0.18) return null;
        const last = this.history[this.history.length - 1];
        if (ac > 0) {
            return { prediction: last, confidence: Math.min(0.55 + ac * 0.8, 0.82), reason: `Regime Xu Hướng (autocorr=${ac.toFixed(2)}) → Theo Chuỗi` };
        } else {
            return { prediction: last === 'T' ? 'X' : 'T', confidence: Math.min(0.55 + (-ac) * 0.8, 0.82), reason: `Regime Nhịp (autocorr=${ac.toFixed(2)}) → Đảo Chiều` };
        }
    }

    // Model 10: Ty le thuc te TAI/XIU tren N phien gan nhat (base-rate bias)
    model10() {
        if (this.detailedHistory.length < 8) return null;
        const recent = this.detailedHistory.slice(-20);
        const tCount = recent.filter(s => s >= 11).length;
        const n = recent.length;
        const pT = (tCount + 0.5) / (n + 1);
        if (Math.abs(pT - 0.5) < 0.12) return null;
        const pred = pT > 0.5 ? 'T' : 'X';
        const conf = Math.min(0.55 + Math.abs(pT - 0.5) * 1.3, 0.85);
        return { prediction: pred, confidence: conf, reason: `Tỷ Lệ Thực Tế ${n} phiên: TÀI ${(pT * 100).toFixed(0)}%` };
    }

    // ===== CHẾ ĐỘ TIẾP TỤC HUẤN LUYỆN (không ảnh hưởng giao diện) =====
    saveState() {
        return {
            history: this.history,
            detailedHistory: this.detailedHistory,
            weights: this.weights,
            modelHits: this.modelHits,
            sessionStats: this.sessionStats,
            marketState: this.marketState,
            autocorr: this.autocorr,
            entropy: this.entropy,
            streakSurvival: this.streakSurvival,
            consecutiveLosses: this.consecutiveLosses,
            balancedLastPreds: this.balancedLastPreds || [],
            ts: Date.now()
        };
    }
    loadState(s) {
        if (!s) return;
        try {
            if (Array.isArray(s.history)) this.history = s.history.slice(-300);
            if (Array.isArray(s.detailedHistory)) this.detailedHistory = s.detailedHistory.slice(-200);
            if (s.weights) this.weights = s.weights;
            if (s.modelHits) this.modelHits = s.modelHits;
            if (s.sessionStats) this.sessionStats = s.sessionStats;
            if (s.marketState) this.marketState = s.marketState;
            if (typeof s.autocorr === 'number') this.autocorr = s.autocorr;
            if (typeof s.entropy === 'number') this.entropy = s.entropy;
            if (s.streakSurvival) this.streakSurvival = s.streakSurvival;
            if (typeof s.consecutiveLosses === 'number') this.consecutiveLosses = s.consecutiveLosses;
            if (Array.isArray(s.balancedLastPreds)) this.balancedLastPreds = s.balancedLastPreds.slice(-20);
            // dam bao cac model moi deu co trong so / EWMA mac dinh
            for (const k in this.models) {
                if (!(k in this.weights)) {
                    this.weights[k] = (k === 'model1') ? 0.25
                        : (k === 'model_antiBreak' ? 1.55
                        : (k === 'model19' ? 1.15
                        : (k === 'model17' ? 0.85 : 1.0)));
                }
                if (!(k in this.modelHits)) this.modelHits[k] = { win: 0, loss: 0, ewma: 0.5 };
            }
            // Chống bias 1-1 từ state cũ: hạ model1, nâng antiBreak
            if (this.weights['model1'] && this.weights['model1'] > 0.2) this.weights['model1'] = 0.08;
            if (this.weights['model17'] && this.weights['model17'] > 0.75) this.weights['model17'] = 0.7;
            if (this.models['model_antiBreak'] && (!this.weights['model_antiBreak'] || this.weights['model_antiBreak'] < 1.3))
                this.weights['model_antiBreak'] = 1.9;
        } catch (e) { console.warn('loadState failed:', e); }
    }

    // ===== MODEL 11-15: tích hợp từ thuattoan8.txt + thuattoan123/sun_algo =====
    // Model 11: Bảng tra cứu 8-gram (4950 mẫu, majority vote trên 256 tổ hợp)
    model11() {
        if (this.history.length < 8) return null;
        const key = this.history.slice(-8).join('');
        if (!this._gram8) this._gram8 = {"TTTTTTTT":"T","TTTTTTTX":"X","TTTTTTXT":"X","TTTTTTXX":"X","TTTTTXTT":"X","TTTTTXTX":"T","TTTTTXXT":"T","TTTTTXXX":"X","TTTTXTTT":"T","TTTTXTTX":"X","TTTTXTXT":"T","TTTTXTXX":"T","TTTTXXTT":"T","TTTTXXTX":"X","TTTTXXXT":"X","TTTTXXXX":"X","TTTXTTTT":"X","TTTXTTTX":"X","TTTXTTXT":"X","TTTXTTXX":"X","TTTXTXTT":"X","TTTXTXTX":"T","TTTXTXXT":"X","TTTXTXXX":"X","TTTXXTTT":"T","TTTXXTTX":"T","TTTXXTXT":"T","TTTXXTXX":"X","TTTXXXTT":"X","TTTXXXTX":"X","TTTXXXXT":"T","TTTXXXXX":"X","TTXTTTTT":"X","TTXTTTTX":"X","TTXTTTXT":"T","TTXTTTXX":"T","TTXTTXTT":"T","TTXTTXTX":"T","TTXTTXXT":"X","TTXTTXXX":"T","TTXTXTTT":"T","TTXTXTTX":"T","TTXTXTXT":"X","TTXTXTXX":"X","TTXTXXTT":"T","TTXTXXTX":"T","TTXTXXXT":"X","TTXTXXXX":"T","TTXXTTTT":"T","TTXXTTTX":"X","TTXXTTXT":"X","TTXXTTXX":"T","TTXXTXTT":"T","TTXXTXTX":"T","TTXXTXXT":"X","TTXXTXXX":"T","TTXXXTTT":"X","TTXXXTTX":"T","TTXXXTXT":"T","TTXXXTXX":"X","TTXXXXTT":"X","TTXXXXTX":"X","TTXXXXXT":"X","TTXXXXXX":"T","TXTTTTTT":"X","TXTTTTTX":"X","TXTTTTXT":"X","TXTTTTXX":"X","TXTTTXTT":"T","TXTTTXTX":"X","TXTTTXXT":"X","TXTTTXXX":"X","TXTTXTTT":"T","TXTTXTTX":"X","TXTTXTXT":"X","TXTTXTXX":"T","TXTTXXTT":"T","TXTTXXTX":"T","TXTTXXXT":"X","TXTTXXXX":"T","TXTXTTTT":"T","TXTXTTTX":"T","TXTXTTXT":"T","TXTXTTXX":"T","TXTXTXTT":"X","TXTXTXTX":"X","TXTXTXXT":"X","TXTXTXXX":"T","TXTXXTTT":"X","TXTXXTTX":"X","TXTXXTXT":"T","TXTXXTXX":"T","TXTXXXTT":"X","TXTXXXTX":"T","TXTXXXXT":"X","TXTXXXXX":"X","TXXTTTTT":"T","TXXTTTTX":"X","TXXTTTXT":"T","TXXTTTXX":"T","TXXTTXTT":"X","TXXTTXTX":"T","TXXTTXXT":"X","TXXTTXXX":"X","TXXTXTTT":"T","TXXTXTTX":"X","TXXTXTXT":"X","TXXTXTXX":"T","TXXTXXTT":"T","TXXTXXTX":"X","TXXTXXXT":"X","TXXTXXXX":"X","TXXXTTTT":"T","TXXXTTTX":"X","TXXXTTXT":"T","TXXXTTXX":"T","TXXXTXTT":"X","TXXXTXTX":"T","TXXXTXXT":"X","TXXXTXXX":"T","TXXXXTTT":"T","TXXXXTTX":"X","TXXXXTXT":"T","TXXXXTXX":"T","TXXXXXTT":"X","TXXXXXTX":"X","TXXXXXXT":"T","TXXXXXXX":"T","XTTTTTTT":"T","XTTTTTTX":"T","XTTTTTXT":"T","XTTTTTXX":"X","XTTTTXTT":"T","XTTTTXTX":"T","XTTTTXXT":"X","XTTTTXXX":"X","XTTTXTTT":"X","XTTTXTTX":"T","XTTTXTXT":"T","XTTTXTXX":"X","XTTTXXTT":"T","XTTTXXTX":"T","XTTTXXXT":"T","XTTTXXXX":"X","XTTXTTTT":"T","XTTXTTTX":"T","XTTXTTXT":"X","XTTXTTXX":"T","XTTXTXTT":"X","XTTXTXTX":"X","XTTXTXXT":"T","XTTXTXXX":"X","XTTXXTTT":"T","XTTXXTTX":"T","XTTXXTXT":"X","XTTXXTXX":"X","XTTXXXTT":"X","XTTXXXTX":"T","XTTXXXXT":"X","XTTXXXXX":"T","XTXTTTTT":"T","XTXTTTTX":"T","XTXTTTXT":"X","XTXTTTXX":"T","XTXTTXTT":"T","XTXTTXTX":"T","XTXTTXXT":"X","XTXTTXXX":"X","XTXTXTTT":"T","XTXTXTTX":"T","XTXTXTXT":"T","XTXTXTXX":"X","XTXTXXTT":"T","XTXTXXTX":"X","XTXTXXXT":"T","XTXTXXXX":"T","XTXXTTTT":"X","XTXXTTTX":"T","XTXXTTXT":"T","XTXXTTXX":"T","XTXXTXTT":"X","XTXXTXTX":"T","XTXXTXXT":"T","XTXXTXXX":"T","XTXXXTTT":"T","XTXXXTTX":"X","XTXXXTXT":"X","XTXXXTXX":"T","XTXXXXTT":"T","XTXXXXTX":"T","XTXXXXXT":"X","XTXXXXXX":"T","XXTTTTTT":"X","XXTTTTTX":"T","XXTTTTXT":"T","XXTTTTXX":"X","XXTTTXTT":"T","XXTTTXTX":"X","XXTTTXXT":"X","XXTTTXXX":"T","XXTTXTTT":"X","XXTTXTTX":"X","XXTTXTXT":"X","XXTTXTXX":"T","XXTTXXTT":"T","XXTTXXTX":"T","XXTTXXXT":"T","XXTTXXXX":"X","XXTXTTTT":"T","XXTXTTTX":"X","XXTXTTXT":"T","XXTXTTXX":"T","XXTXTXTT":"T","XXTXTXTX":"X","XXTXTXXT":"T","XXTXTXXX":"T","XXTXXTTT":"T","XXTXXTTX":"X","XXTXXTXT":"X","XXTXXTXX":"X","XXTXXXTT":"T","XXTXXXTX":"X","XXTXXXXT":"X","XXTXXXXX":"T","XXXTTTTT":"T","XXXTTTTX":"X","XXXTTTXT":"T","XXXTTTXX":"T","XXXTTXTT":"T","XXXTTXTX":"X","XXXTTXXT":"X","XXXTTXXX":"X","XXXTXTTT":"X","XXXTXTTX":"X","XXXTXTXT":"T","XXXTXTXX":"X","XXXTXXTT":"T","XXXTXXTX":"X","XXXTXXXT":"T","XXXTXXXX":"T","XXXXTTTT":"T","XXXXTTTX":"T","XXXXTTXT":"T","XXXXTTXX":"T","XXXXTXTT":"T","XXXXTXTX":"T","XXXXTXXT":"T","XXXXTXXX":"T","XXXXXTTT":"T","XXXXXTTX":"T","XXXXXTXT":"T","XXXXXTXX":"X","XXXXXXTT":"X","XXXXXXTX":"T","XXXXXXXT":"T","XXXXXXXX":"X"};
        const pred = this._gram8[key];
        if (!pred) return null;
        return { prediction: pred, confidence: 0.72, reason: `Bảng Tra Cứu 8-Gram: [${key}] → ${pred === 'T' ? 'TÀI' : 'XỈU'}` };
    }
    // Model 12: Cyclic-7 — 7 phiên cuối trùng hoàn toàn 7 phiên liền trước → theo chu kỳ
    model12() {
        if (this.history.length < 14) return null;
        const a = this.history.slice(-7).join('');
        const b = this.history.slice(-14, -7).join('');
        if (a !== b) return null;
        const pred = this.history[this.history.length - 7];
        return { prediction: pred, confidence: 0.75, reason: `Chu Kỳ 7 Phiên Lặp Lại → theo chu kỳ ${pred === 'T' ? 'TÀI' : 'XỈU'}` };
    }
    // Model 13: Momentum-break — 6 phiên lệch mạnh, 3 phiên cuối ngược chiều → quay lại momentum
    model13() {
        if (this.history.length < 9) return null;
        const first6 = this.history.slice(-9, -3);
        const last3 = this.history.slice(-3);
        const t6 = first6.filter(x => x === 'T').length;
        if (Math.abs(t6 - (6 - t6)) < 4) return null;
        if (!(last3[0] === last3[1] && last3[1] === last3[2])) return null;
        const momSide = t6 > 3 ? 'T' : 'X';
        if (last3[0] === momSide) return null;
        return { prediction: momSide, confidence: 0.71, reason: `Momentum Bị Phá Vỡ (3 phiên ngược) → Quay Lại ${momSide === 'T' ? 'TÀI' : 'XỈU'}` };
    }
    // Model 14: 5 phiên đan xen hoàn hảo → tiếp tục nhịp (đảo chiều)
    model14() {
        if (this.history.length < 5) return null;
        const last5 = this.history.slice(-5);
        for (let i = 1; i < 5; i++) if (last5[i] === last5[i-1]) return null;
        const pred = last5[4] === 'T' ? 'X' : 'T';
        return { prediction: pred, confidence: 0.68, reason: '5 Phiên Đan Xen Hoàn Hảo → Tiếp Tục Nhịp (Đảo Chiều)' };
    }
    // Model 15: Mất cân bằng động — 6/8 hoặc 4/6 nghiêng một bên, phiên cuối là bên đó → hồi quy
    model15() {
        if (this.history.length < 8) return null;
        const last8 = this.history.slice(-8);
        const t8 = last8.filter(x => x === 'T').length;
        const last = last8[7];
        if (t8 >= 6 && last === 'T') return { prediction: 'X', confidence: 0.78, reason: `Mất Cân Nặng Mạnh (${t8}/8 TÀI, cuối TÀI) → Hồi Quy XỈU` };
        if ((8 - t8) >= 6 && last === 'X') return { prediction: 'T', confidence: 0.78, reason: `Mất Cân Nặng Mạnh (${8 - t8}/8 XỈU, cuối XỈU) → Hồi Quy TÀI` };
        const last6 = last8.slice(-6);
        const t6 = last6.filter(x => x === 'T').length;
        if (t6 >= 4 && last === 'T') return { prediction: 'X', confidence: 0.72, reason: `Mất Cân Nặng (${t6}/6 TÀI, cuối TÀI) → Hồi Quy XỈU` };
        if ((6 - t6) >= 4 && last === 'X') return { prediction: 'T', confidence: 0.72, reason: `Mất Cân Nặng (${6 - t6}/6 XỈU, cuối XỈU) → Hồi Quy TÀI` };
        return null;
    }

    getAllPredictions() {
        const predictions = {};
        for (const [modelName, modelFunc] of Object.entries(this.models)) {
            try {
                const res = modelFunc();
                if (res) {
                    predictions[modelName] = res;
                    this.lastPredictions[modelName] = res;
                }
            } catch (e) {
                console.error(`Error in ${modelName}:`, e);
            }
        }
        return predictions;
    }

    // MODEL 16: Bảng pattern 8-ký tự (thuattoan8) — lookup chuỗi gần nhất
    model16() {
        if (this.history.length < 4) return null;
        const table = Engine.PATTERN8 || {};
        // thử từ dài → ngắn
        for (let len = 8; len >= 4; len--) {
            if (this.history.length < len) continue;
            const key = this.history.slice(-len).join('');
            if (table[key]) {
                const pred = table[key];
                return {
                    prediction: pred,
                    confidence: len >= 8 ? 0.78 : (len >= 6 ? 0.68 : 0.58),
                    reason: `Pattern-${len} khớp bảng cầu (${key} → ${pred === 'T' ? 'TÀI' : 'XỈU'})`
                };
            }
        }
        return null;
    }

    // MODEL 17: RLE — đọc cầu thật (bệt / 2-2 / 3-3 / a-b), KHÔNG mặc định 1-1
    model17() {
        if (this.history.length < 6) return null;
        const rle = [];
        let cur = this.history[0], cnt = 1;
        for (let i = 1; i < this.history.length; i++) {
            if (this.history[i] === cur) cnt++;
            else { rle.push([cur, cnt]); cur = this.history[i]; cnt = 1; }
        }
        rle.push([cur, cnt]);

        const last = rle[rle.length - 1];
        const prev = rle.length >= 2 ? rle[rle.length - 2] : null;
        const prev2 = rle.length >= 3 ? rle[rle.length - 3] : null;

        // --- Bệt đang chạy (count >= 2): ưu tiên TIẾP tục, không vội đảo ---
        if (last[1] >= 2) {
            // nhịp a-b ổn định: prev.count == last.count và prev2 cùng pattern
            if (prev && last[1] === prev[1] && last[1] >= 2) {
                // vừa khép nhịp a-b (vd 2-2 vừa đủ) → đảo sang cửa kia bắt nhịp mới
                const pred = last[0] === 'T' ? 'X' : 'T';
                return { prediction: pred, confidence: 0.70, reason: `Nhịp ${prev[1]}-${last[1]} vừa khép → sang cửa kia` };
            }
            // đang trong bệt / nhịp chưa đủ so với nhịp trước → TIẾP
            if (prev && last[1] < prev[1]) {
                return { prediction: last[0], confidence: 0.68 + Math.min(0.1, last[1] * 0.02), reason: `Theo nhịp ${prev[1]}-${last[1]}: tiếp ${last[0] === 'T' ? 'TÀI' : 'XỈU'}` };
            }
            // bệt thuần (không có prev hoặc prev ngắn)
            if (last[1] >= 3 && last[1] <= 6) {
                return { prediction: last[0], confidence: 0.72 + Math.min(0.12, (last[1] - 3) * 0.03), reason: `Cầu bệt ${last[1]} → tiếp ${last[0] === 'T' ? 'TÀI' : 'XỈU'}` };
            }
            // bệt quá dài (>=7) mới nghiêng gãy
            if (last[1] >= 7) {
                const pred = last[0] === 'T' ? 'X' : 'T';
                return { prediction: pred, confidence: Math.min(0.78, 0.55 + last[1] * 0.03), reason: `Bệt ${last[1]} dài → nghiêng gãy` };
            }
            // streak 2: tiếp nhẹ
            return { prediction: last[0], confidence: 0.62, reason: `Streak 2 → nghiêng tiếp ${last[0] === 'T' ? 'TÀI' : 'XỈU'}` };
        }

        // --- last count === 1: vừa flip ---
        if (last[1] === 1 && prev) {
            // Nếu trước đó là bệt dài (>=3) rồi mới 1 nhịp ngược → có thể gãy cầu, chưa chắc 1-1
            // → dự đoán theo hướng "xác nhận gãy" (tiếp cửa mới) với conf thấp-trung
            if (prev[1] >= 3) {
                return { prediction: last[0], confidence: 0.60, reason: `Bệt ${prev[1]} gãy 1 nhịp → xác nhận cửa ${last[0] === 'T' ? 'TÀI' : 'XỈU'}` };
            }
            // True 1-1: nhiều đoạn count=1 liên tiếp
            const ones = [];
            for (let i = rle.length - 1; i >= 0 && rle[i][1] === 1; i--) ones.push(rle[i]);
            if (ones.length >= 6) {
                const pred = last[0] === 'T' ? 'X' : 'T';
                return { prediction: pred, confidence: 0.60, reason: `1-1 xác nhận (${ones.length} nhịp) → đảo` };
            }
            // 2-1 hoặc nhiễu: không ép 1-1 — theo cửa vừa ra (xác nhận)
            if (prev[1] === 2) {
                return { prediction: last[0], confidence: 0.58, reason: 'Nhịp 2-1: xác nhận cửa mới' };
            }
            // mặc định: không đoán 1-1 ảo
            return null;
        }

        return null;
    }

    // MODEL 18: Dynamic patterns (từ UltraDice — mất cân / chu kỳ / momentum break)
    model18() {
        const h = this.history;
        if (h.length < 6) return null;
        // 4T/6 cuối T → X
        const last6 = h.slice(-6);
        if (last6.filter(x => x === 'T').length >= 4 && last6[5] === 'T') {
            return { prediction: 'X', confidence: 0.72, reason: '4+T/6 phiên, cuối T → hồi XỈU' };
        }
        if (last6.filter(x => x === 'X').length >= 4 && last6[5] === 'X') {
            return { prediction: 'T', confidence: 0.72, reason: '4+X/6 phiên, cuối X → hồi TÀI' };
        }
        if (h.length >= 8) {
            const last8 = h.slice(-8);
            const t8 = last8.filter(x => x === 'T').length;
            if (t8 >= 6 && last8[7] === 'T') return { prediction: 'X', confidence: 0.78, reason: '6+T/8, cuối T → X mạnh' };
            if ((8 - t8) >= 6 && last8[7] === 'X') return { prediction: 'T', confidence: 0.78, reason: '6+X/8, cuối X → T mạnh' };
        }
        // 5 phiên đan xen
        if (h.length >= 5) {
            const last5 = h.slice(-5);
            let alt = true;
            for (let i = 1; i < 5; i++) if (last5[i] === last5[i - 1]) { alt = false; break; }
            if (alt) {
                const pred = last5[4] === 'T' ? 'X' : 'T';
                return { prediction: pred, confidence: 0.68, reason: '5 phiên đan xen → đảo' };
            }
        }
        // chu kỳ 7
        if (h.length >= 14) {
            const a = h.slice(-14, -7).join('');
            const b = h.slice(-7).join('');
            if (a === b) {
                return { prediction: h[h.length - 7], confidence: 0.75, reason: 'Chu kỳ 7 lặp → theo chu kỳ' };
            }
        }
        return null;
    }

    // MODEL 19: Balanced Predictor v3 — tỷ lệ cửa sổ + Markov + streak + random có kiểm soát
    model19() {
        const h = this.history;
        if (!h || h.length < 10) return null;

        // history engine: cũ → mới; balanced gốc dùng mới → cũ → đảo
        const results = h.slice().reverse(); // [0] = mới nhất
        const total = results.length;
        const totalT = results.filter(r => r === 'T').length;
        const totalRatio = totalT / total;

        const winRatio = (size) => {
            if (total < size) return totalRatio;
            const slice = results.slice(0, size);
            return slice.filter(r => r === 'T').length / size;
        };
        const recent10 = winRatio(10);
        const recent20 = winRatio(20);
        const recent50 = winRatio(50);

        // streak từ phiên mới nhất
        let streak = 1;
        const currentSide = results[0];
        for (let i = 1; i < results.length; i++) {
            if (results[i] === currentSide) streak++;
            else break;
        }

        // Markov bậc 1 (trên chuỗi mới→cũ vẫn đúng transition nếu duyệt i → i+1 theo hướng thời gian ngược... 
        // Dùng chuỗi theo thời gian tăng: h
        let t2t = 0, t2x = 0, x2t = 0, x2x = 0;
        for (let i = 0; i < h.length - 1; i++) {
            const cur = h[i], next = h[i + 1];
            if (cur === 'T') next === 'T' ? t2t++ : t2x++;
            else next === 'T' ? x2t++ : x2x++;
        }
        const totT = t2t + t2x, totX = x2t + x2x;
        const pTfromT = totT > 0 ? t2t / totT : 0.5;
        const pTfromX = totX > 0 ? x2t / totX : 0.5;
        let markovT = (h[h.length - 1] === 'T' ? pTfromT : pTfromX);
        markovT = markovT * 0.7 + 0.15; // làm mượt về 0.5

        // trend score
        const avgRatio = (totalRatio + recent10 + recent20 + recent50) / 4;
        let trendScore = (avgRatio - 0.5) * 2;
        const markovScore = (markovT - 0.5) * 2;
        trendScore = trendScore * 0.7 + markovScore * 0.3;

        // streak ngắn-trung (2-5): CỘNG theo hướng bệt, không vội đảo
        if (streak >= 2 && streak <= 5) {
            const direction = currentSide === 'T' ? 1 : -1;
            trendScore += direction * (0.08 + streak * 0.03);
        }
        // chỉ khi bệt rất dài (>=6) mới nghiêng gãy nhẹ
        if (streak >= 6) {
            const direction = currentSide === 'T' ? 1 : -1;
            if (trendScore * direction > 0) {
                trendScore -= direction * 0.15 * Math.min(1, (streak - 5) / 4);
            }
        }

        // random có kiểm soát
        let finalScore;
        if (Math.abs(trendScore) < 0.15) {
            const base = (totalRatio - 0.5) * 2;
            const noise = (Math.random() * 0.3) - 0.15;
            finalScore = base * 0.5 + noise;
        } else {
            const noise = (Math.random() * 0.2) - 0.1;
            finalScore = Math.min(0.6, Math.max(-0.6, trendScore + noise));
        }

        // chống bệt dự đoán model này
        const recent = this.balancedLastPreds.slice(-3);
        if (recent.length === 3 && recent.every(p => p === recent[0])) {
            finalScore = -finalScore * 0.8;
        }

        const prediction = finalScore > 0 ? 'T' : 'X';
        this.balancedLastPreds.push(prediction);
        if (this.balancedLastPreds.length > 20) this.balancedLastPreds.shift();

        const confidence = Math.min(0.85, Math.max(0.5, 0.5 + Math.abs(finalScore) * 0.4));
        let reason;
        if (streak >= 6) reason = `Balanced: bệt ${streak} ${currentSide === 'T' ? 'Tài' : 'Xỉu'} → nghiêng gãy`;
        else if (streak >= 2) reason = `Balanced: theo bệt ${streak} ${currentSide === 'T' ? 'Tài' : 'Xỉu'}`;
        else reason = `Balanced v3 · trend ${trendScore.toFixed(2)}`;

        return { prediction, confidence, reason };
    }


    // MODEL 20: VIP Pattern Reader — đọc cầu đa khung + majority + streak context
    model20() {
        const h = this.history;
        if (!h || h.length < 12) return null;
        const last = h[h.length - 1];
        let streak = 1;
        for (let i = h.length - 2; i >= 0; i--) {
            if (h[i] === last) streak++; else break;
        }

        // RLE segments
        const segs = [];
        let c = h[0], n = 1;
        for (let i = 1; i < h.length; i++) {
            if (h[i] === c) n++;
            else { segs.push([c, n]); c = h[i]; n = 1; }
        }
        segs.push([c, n]);

        // Cầu bệt rõ
        if (streak >= 3 && streak <= 5) {
            return { prediction: last, confidence: 0.74 + Math.min(0.1, streak * 0.02), reason: `VIP: bệt ${streak} → theo ${last === 'T' ? 'TÀI' : 'XỈU'}` };
        }
        if (streak >= 6) {
            // hazard: long streak often breaks but not always
            const breakP = Math.min(0.55, 0.35 + (streak - 6) * 0.04);
            if (breakP > 0.48) {
                return { prediction: last === 'T' ? 'X' : 'T', confidence: 0.62 + (streak - 6) * 0.02, reason: `VIP: bệt ${streak} dài → nghiêng gãy` };
            }
            return { prediction: last, confidence: 0.6, reason: `VIP: bệt ${streak} còn giữ` };
        }

        // Nhịp đều a-a (2-2, 3-3)
        if (segs.length >= 4) {
            const a = segs[segs.length - 1], b = segs[segs.length - 2], c2 = segs[segs.length - 3];
            if (a[1] === b[1] && a[1] >= 2 && a[1] === c2[1]) {
                // vừa đủ nhịp → đảo
                if (a[1] === b[1]) {
                    return { prediction: a[0] === 'T' ? 'X' : 'T', confidence: 0.71, reason: `VIP: nhịp ${a[1]}-${a[1]} đều → sang cửa` };
                }
            }
            if (b[1] >= 2 && a[1] < b[1] && a[1] >= 1) {
                return { prediction: a[0], confidence: 0.66, reason: `VIP: theo nhịp ${b[1]} → tiếp` };
            }
        }

        // Majority cửa sổ 8/12/20 lệch rõ
        const votes = { T: 0, X: 0 };
        [8, 12, 20].forEach(sz => {
            if (h.length < sz) return;
            const sl = h.slice(-sz);
            const tC = sl.filter(x => x === 'T').length;
            if (tC / sz >= 0.62) votes.T++;
            else if (tC / sz <= 0.38) votes.X++;
        });
        if (votes.T >= 2) return { prediction: 'T', confidence: 0.64, reason: 'VIP: đa khung nghiêng TÀI' };
        if (votes.X >= 2) return { prediction: 'X', confidence: 0.64, reason: 'VIP: đa khung nghiêng XỈU' };

        // True 1-1 only
        const last6 = h.slice(-6).join('');
        if (last6 === 'TXTXTX' || last6 === 'XTXTXT') {
            return { prediction: last === 'T' ? 'X' : 'T', confidence: 0.63, reason: 'VIP: 1-1 sạch 6 phiên' };
        }
        return null;
    }


    // MODEL 21: Đọc cầu chất lượng cao — phân loại cầu + độ tin theo độ ổn định nhịp
    model21() {
        const h = this.history;
        if (!h || h.length < 10) return null;
        const segs = [];
        let c = h[0], n = 1;
        for (let i = 1; i < h.length; i++) {
            if (h[i] === c) n++; else { segs.push([c, n]); c = h[i]; n = 1; }
        }
        segs.push([c, n]);
        const last = segs[segs.length - 1];
        const prev = segs.length >= 2 ? segs[segs.length - 2] : null;
        // Cầu bệt ổn định 3-5
        if (last[1] >= 3 && last[1] <= 5) {
            return { prediction: last[0], confidence: 0.76 + Math.min(0.08, (last[1] - 3) * 0.02), reason: `Cầu bệt ${last[1]} rõ → theo ${last[0] === 'T' ? 'TÀI' : 'XỈU'}` };
        }
        // Nhịp k-k đều (2-2, 3-3)
        if (prev && last[1] === prev[1] && last[1] >= 2 && segs.length >= 4) {
            const p2 = segs[segs.length - 3];
            if (p2[1] === last[1]) {
                return { prediction: last[0] === 'T' ? 'X' : 'T', confidence: 0.73, reason: `Nhịp ${last[1]}-${last[1]} khép → sang cửa` };
            }
        }
        // Đang dở nhịp so với prev
        if (prev && last[1] < prev[1] && last[1] >= 1 && prev[1] >= 2) {
            return { prediction: last[0], confidence: 0.70, reason: `Theo nhịp ${prev[1]}: tiếp ${last[0] === 'T' ? 'TÀI' : 'XỈU'} (${last[1]}/${prev[1]})` };
        }
        // 1-1 thật: ≥5 đoạn count=1
        let ones = 0;
        for (let i = segs.length - 1; i >= 0 && segs[i][1] === 1; i--) ones++;
        if (ones >= 7) {
            return { prediction: last[0] === 'T' ? 'X' : 'T', confidence: 0.62, reason: `1-1 sạch ${ones} nhịp → đảo` };
        }
        return null;
    }

    // ====== SIÊU THUẬT TOÁN MỚI (model22-25) ======
    model22() {
        // Fibonacci Streak: đảo chiều tại các mốc Fibonacci (1,2,3,5,8,13)
        const h = this.history; if (!h || h.length < 3) return null;
        const last = h[h.length-1]; let streak = 1;
        for (let i = h.length-2; i >= 0 && h[i] === last; i--) streak++;
        const fibs = [1,2,3,5,8,13,21];
        if (fibs.includes(streak)) {
            return { prediction: last === 'T' ? 'X' : 'T', confidence: 0.72 + Math.min(0.15, streak*0.01), reason: `Fibonacci @ chuỗi ${streak} → đảo chiều` };
        }
        return { prediction: last, confidence: 0.58, reason: `Fibonacci: chuỗi ${streak} chưa tới mốc → tiếp` };
    }
    model23() {
        // Markov 2-step: dựa trên cặp 2 kết quả cuối
        const h = this.history; if (!h || h.length < 10) return null;
        const last2 = h.slice(-2).join('');
        let tCount = 0, xCount = 0;
        for (let i = 0; i < h.length - 2; i++) {
            if (h[i] === h[h.length-2] && h[i+1] === h[h.length-1]) {
                if (h[i+2] === 'T') tCount++; else xCount++;
            }
        }
        const total = tCount + xCount;
        if (total < 3) return null;
        if (tCount > xCount) return { prediction: 'T', confidence: 0.55 + (tCount/total)*0.2, reason: `Markov 2-step [${last2}]: T=${tCount} X=${xCount}` };
        return { prediction: 'X', confidence: 0.55 + (xCount/total)*0.2, reason: `Markov 2-step [${last2}]: T=${tCount} X=${xCount}` };
    }
    model24() {
        // Entropy: đo độ ngẫu nhiên — nếu quá ngẫu nhiên thì cảnh báo, dự đoán nhẹ
        const h = this.history; if (!h || h.length < 8) return null;
        const recent = h.slice(-10);
        const t = recent.filter(x => x === 'T').length;
        const x = recent.length - t;
        const pT = t/recent.length, pX = x/recent.length;
        const entropy = -(pT * Math.log2(pT||0.01) + pX * Math.log2(pX||0.01));
        if (entropy > 0.95) return { prediction: h[h.length-1], confidence: 0.52, reason: `Entropy cao ${entropy.toFixed(2)} → ngẫu nhiên, cẩn thận` };
        const pick = t >= x ? 'T' : 'X';
        return { prediction: pick, confidence: 0.62 + (1-entropy)*0.2, reason: `Entropy ${entropy.toFixed(2)} → lệch ${pick==='T'?'TÀI':'XỈU'}` };
    }
    model25() {
        // Weighted Recent: nặng kết quả gần nhất (EWMA)
        const h = this.history; if (!h || h.length < 5) return null;
        let wT = 0, wX = 0, totalW = 0;
        for (let i = 0; i < h.length; i++) {
            const w = Math.pow(0.85, h.length - 1 - i);
            if (h[i] === 'T') wT += w; else wX += w;
            totalW += w;
        }
        if (wT > wX) return { prediction: 'T', confidence: 0.55 + (wT/totalW - 0.5)*0.5, reason: `EWMA: Tài ${(wT/totalW*100).toFixed(0)}%` };
        return { prediction: 'X', confidence: 0.55 + (wX/totalW - 0.5)*0.5, reason: `EWMA: Xỉu ${(wX/totalW*100).toFixed(0)}%` };
    }

    // Ensemble: Log-odds pooling + trong so EWMA accuracy + shrink + cooling
    getEnsemblePrediction() {
        const allPreds = this.getAllPredictions();
        let logOdds = 0;   // >0 ung voi TAI
        let totalWeight = 0;
        let activeCount = 0;
        let topReason = 'Thuật Toán Engine @SunNetWin';
        let highestW = 0;

        const regime = (this.marketState && this.marketState.regime) || '';
        const isBet = /Bệt|Chuỗi/.test(regime);
        const isNhip = /Nhịp|1-1/.test(regime);

        for (const [modelName, pred] of Object.entries(allPreds)) {
            if (!pred || !pred.prediction) continue;
            let baseW = (this.weights[modelName] !== undefined ? this.weights[modelName] : 1.0);
            // SIÊU NÂNG: học cầu nhiều, giảm 1-1
            if (isBet && (modelName === 'model_antiBreak' || modelName === 'model20' || modelName === 'model17' || modelName === 'model21')) baseW *= 1.35;
            if (isBet && (modelName === 'model16' || modelName === 'model22' || modelName === 'model23')) baseW *= 1.2;
            if (isNhip && modelName === 'model1') baseW *= 0.7; // giảm bắt 1-1 kể cả khi regime nhịp
            if (isBet && modelName === 'model1') baseW *= 0.12;
            if (isBet && modelName === 'model_antiBreak') baseW *= 1.4;
            if (!isNhip && modelName === 'model1') baseW *= 0.35; // hầu như bỏ model1 khi không phải nhịp sạch
            const ewma = this.modelHits[modelName] ? this.modelHits[modelName].ewma : 0.5;
            const accMult = 0.5 + ewma;
            const w = baseW * accMult * pred.confidence;
            activeCount++;

            const p = pred.prediction === 'T' ? pred.confidence : (1 - pred.confidence);
            const pc = Math.min(Math.max(p, 0.1), 0.9);
            logOdds += w * Math.log(pc / (1 - pc));
            totalWeight += w;

            if (w > highestW) { highestW = w; topReason = pred.reason; }
        }

        if (totalWeight === 0) {
            // Fallback: dung ty le co so tu lich su gan nhat (khong random nhu ban cu)
            const recent = this.history.slice(-20);
            const tFreq = recent.length ? recent.filter(c => c === 'T').length / recent.length : 0.5;
            const pT = (tFreq * recent.length + 1) / (recent.length + 2);
            let taiProb = Math.round(pT * 100);
            taiProb = Math.min(Math.max(taiProb, 35), 65);
            const xiuProb = 100 - taiProb;
            const isTai = taiProb >= 50;
            return {
                predictedResult: isTai ? 'TÀI' : 'XỈU',
                confidence: isTai ? taiProb : xiuProb,
                taiProb: taiProb,
                xiuProb: xiuProb,
                activeModels: 0,
                topReason: 'Đang phân tích dữ liệu & khởi tạo Engine @SunNetWin...'
            };
        }

        // Shrink ve 0.5 khi tong trong so thap (it chung khoan)
        const shrink = Math.min(1, totalWeight / 5);
        const aggLo = logOdds * shrink;
        let pT = 1 / (1 + Math.exp(-aggLo));

        // Cooling + shrink: hạn chế tự tin giả khi lịch sử ngắn hoặc thị trường nhiễu.
        const cool = Math.max(0.38, 1 - this.consecutiveLosses * 0.14);
        pT = 0.5 + (pT - 0.5) * cool;
        const historyN = this.history.length;
        const volatility = Number(this.sessionStats.volatility || 0.5);
        const entropy = Number(this.entropy || 1);
        const sampleFactor = Math.min(1, Math.max(0.25, historyN / 40));
        const noiseFactor = (entropy > 0.96 || volatility > 0.78) ? 0.58 : (entropy > 0.9 || volatility > 0.68 ? 0.78 : 1);
        // A clean 1-1 pattern is not treated as a deterministic reversal signal.
        const antiAlternationFactor = isNhip ? 0.72 : 1;
        pT = 0.5 + (pT - 0.5) * sampleFactor * noiseFactor * antiAlternationFactor;

        let taiProb = Math.round(pT * 100);
        taiProb = Math.min(Math.max(taiProb, 30), 70);
        const xiuProb = 100 - taiProb;
        const isTai = taiProb >= 50;
        const finalConfidence = isTai ? taiProb : xiuProb;

        return {
            predictedResult: isTai ? 'TÀI' : 'XỈU',
            confidence: finalConfidence,
            taiProb: taiProb,
            xiuProb: xiuProb,
            activeModels: activeCount,
            topReason: topReason
        };
    }
}

// Load pattern-8 lookup (thuattoan8)
try {
    // pattern8 nhúng sẵn — không cần file pattern8.json
    Engine.PATTERN8 = {"TXXTTXTX": "X", "XXTTXTXX": "X", "XTTXTXXT": "X", "TTXTXXTT": "X", "TXTXXTTT": "X", "XTXXTTTX": "T", "TXXTTTXX": "X", "XXTTTXXT": "T", "XTTTXXTX": "T", "TTTXXTXX": "X", "TTXXTXXX": "X", "TXXTXXXX": "X", "XXTXXXXX": "X", "XTXXXXXT": "T", "TXXXXXTX": "T", "XXXXXTXX": "X", "XXXXTXXX": "T", "XXXTXXXT": "T", "XXTXXXTX": "X", "XTXXXTXX": "T", "TXXXTXXX": "T", "XXXTXXXX": "X", "XXTXXXXT": "X", "XTXXXXTT": "X", "TXXXXTTX": "X", "XXXXTTXX": "X", "XXXTTXXX": "T", "XXTTXXXT": "T", "XTTXXXTX": "T", "TTXXXTXT": "T", "TXXXTXTX": "T", "XXXTXTXT": "X", "XXTXTXTT": "T", "XTXTXTTT": "X", "TXTXTTTT": "T", "XTXTTTTT": "X", "TXTTTTTT": "X", "XTTTTTTX": "X", "TTTTTTXT": "X", "TTTTTXTX": "X", "TTTTXTXT": "X", "TTTXTXTT": "X", "TTXTXTTX": "X", "TXTXTTXT": "X", "XTXTTXTX": "T", "TXTTXTXT": "T", "XTTXTXTT": "X", "TXTTXTXX": "X", "XTTXTXXX": "X", "TTXTXXXT": "T", "TXTXXXTT": "X", "XTXXXTTX": "T", "TXXXTTXX": "T", "XXXTTXXT": "X", "XXTTXXTX": "T", "XTTXXTXX": "X", "TXXTXXXT": "X", "XXTXXXTT": "T", "XTXXXTTT": "T", "TXXXTTTT": "X", "XXXTTTTT": "T", "XXTTTTTT": "X", "TTTTTTXX": "X", "TTTTTXXX": "T", "TTTTXXXT": "X", "TTTXXXTX": "X", "TXXXTXTT": "X", "XXXTXTTX": "X", "XXTXTTXX": "T", "XTXTTXXT": "T", "TXTTXXTT": "T", "XTTXXTTT": "X", "TTXXTTTX": "T", "TXXTTTXT": "X", "XXTTTXTX": "T", "XTTTXTXX": "X", "TTTXTXXX": "X", "XTXTTXXX": "X", "TXTTXXXT": "X", "TTXXXTXX": "X", "TXXXTXXT": "T", "XXXTXXTX": "X", "XXTXXTXT": "X", "XTXXTXTX": "T", "TXXTXTXT": "X", "XTXTXTTX": "X", "XTXTTXTT": "T", "TXTTXTTT": "T", "XTTXTTTX": "X", "TTXTTTXT": "X", "TXTTTXTT": "X", "XTTTXTTX": "T", "TTTXTTXT": "X", "TTXTTXTX": "T", "TTXTXXTX": "T", "TXTXXTXT": "X", "XTXXTXTT": "T", "TXXTXTTT": "T", "XXTXTTTT": "X", "TXTTTTTX": "T", "XTTTTTXX": "T", "TTTTXXXX": "T", "TTTXXXXX": "X", "TTXXXXXX": "X", "TXXXXXXT": "T", "XXXXXXTT": "X", "XXXXXTTX": "X", "XTTXXTXT": "X", "TTXXTXTT": "T", "XTXTTTTX": "T", "TXTTTTXT": "X", "XTTTTXTX": "T", "TTTTXTXX": "X", "TTTXTXXT": "T", "TXTXTTTX": "T", "XTXTTTXX": "T", "TXTTTXXT": "T", "XTTTXXTT": "T", "TTTXXTTT": "T", "TTXXTTTT": "X", "TXXTTTTX": "T", "XXTTTTXT": "X", "TXTXTTXX": "X", "TXTTXXXX": "T", "XTTXXXXT": "X", "TTXXXXTX": "X", "TXXXXTXT": "X", "XXXXTXTX": "T", "TXTTTTXX": "T", "XTTTTXXT": "T", "TTTTXXTX": "T", "XXXTXXTT": "T", "XXTXXTTT": "X", "XXTTTXTT": "X", "TTTXTTXX": "T", "TTXTTXXX": "X", "XTTXXXXX": "T", "TTXXXXXT": "T", "TXXXXXTT": "T", "XXXXXTTT": "X", "XXXXTTTT": "T", "XXXTTTTX": "T", "XTTXTXTX": "T", "TTXTXTXT": "X", "TXTXTXTX": "X", "XTXTXTXT": "X", "XTXTXTXX": "X", "TXTXTXXT": "X", "XTXTXXTX": "T", "XXTXTXTX": "X", "TXTXTXTT": "X", "TXTTTXXX": "T", "XTTTXXXX": "X", "TTTXXXXT": "X", "TTXXXXTT": "X", "XXXTXTXX": "T", "XXTXTXXX": "X", "XTXTXXXT": "X", "XXTTXXTT": "T", "TXXTTTTT": "X", "TTTTTXTT": "X", "TTTTXTTT": "T", "TTTXTTTT": "X", "TTXTTTTX": "X", "XTXXTTTT": "T", "XTTTTXTT": "T", "XTTTTXXX": "X", "TXXXXTTT": "X", "XXXXTTTX": "T", "XXXTTTXX": "X", "TXTXTXXX": "X", "XXTTTTXX": "X", "TTTXXXTT": "T", "TTXXXTTX": "T", "TXXXTTXT": "X", "XXXTTXTT": "T", "XXTTXTTX": "X", "XTTXTTXX": "X", "TTXTTXXT": "T", "TTTXXTXT": "X", "TTXXTXTX": "X", "TXTXXXTX": "X", "TTTTXXTT": "T", "XTTTTTTT": "T", "TTTTTTTT": "X", "TTTTTTTX": "T", "TTTTTXXT": "T", "TTTXXTTX": "T", "TTXXTTXX": "T", "TXXTTXXT": "X", "TTXXTXXT": "T", "TXXTXXTX": "T", "XXTXXTXX": "X", "XTXXTXXX": "X", "XTXXXXTX": "T", "XXXXTXTT": "T", "XXXTXTTT": "X", "TXXTXXTT": "T", "XXXXXTXT": "T", "XTTXXXTT": "T", "XXTTXXXX": "X", "TXTTXTTX": "T", "XTTXTTXT": "X", "TTXTTXTT": "T", "XTTXTTTT": "X", "TTXTTTTT": "X", "TTTTXTTX": "X", "TTXTXXXX": "T", "TXTXXXXT": "T", "XXTTTTTX": "X", "XTTTTTXT": "T", "TTTXTXTX": "X", "TXTXXTXX": "X", "XTXXTXXT": "T", "XTXTXXXX": "T", "TXXXXTXX": "T", "TTXTXTXX": "X", "XTXTXXTT": "T", "TXXXTTTX": "X", "XXXTTTXT": "X", "XXTTTXXX": "T", "XTTTXXXT": "X", "TTXXXTTT": "X", "TXXTXTTX": "T", "TXTTXXTX": "X", "XXTXTTTX": "X", "XTXXXXXX": "T", "TXXXXXXX": "X", "XXXXXXXT": "X", "XXXXTTXT": "T", "XXXTTXTX": "X", "TXTXXXXX": "X", "XXXXTXXT": "X", "TXXTXTXX": "T", "XXTXTXXT": "T", "TXTXXTTX": "X", "XTXXTTXX": "X", "TXXTTXXX": "X", "XXTTXTTT": "T", "TTXTTTXX": "T", "XXXXXXTX": "X", "TTTXTTTX": "X", "XTTTXTTT": "T", "TXTTTXTX": "X", "XTXXXTXT": "X", "XTTXXTTX": "T", "TTXXTTXT": "X", "XXTTXTXT": "X", "XXTXXTTX": "X", "TXTT": "X", "TXTTT": "X", "TXTTTX": "X", "TXTTTXX": "X", "XXTXTTXT": "X", "TTXTXTTT": "X", "XTXTTTXT": "T", "XTTTXTXT": "X", "XTXXTTXT": "X", "TXXTTXTT": "X", "XXTT": "T", "XXTTT": "T", "XXTTTT": "X", "XXTTTTX": "X", "XTXX": "T", "XTXXT": "T", "XTXXTT": "T", "XTXXTTT": "T", "XXXXXXXX": "T", "TXXT": "T", "TXXTT": "T", "TXXTTT": "X", "TXXTTTX": "T", "XTTT": "X", "XTTTX": "X", "XTTTXX": "T", "XTTTXXX": "T", "TTXT": "X", "TTXTX": "X", "TTXTXX": "X", "TTXTXXX": "X", "XTTTXXT": "T", "TXTTX": "T", "TXTTXT": "T", "TXTTXTT": "T", "TXXX": "T", "TXXXT": "T", "TXXXTT": "T", "TXXXTTT": "X", "XXTX": "T", "XXTXT": "X", "XXTXTX": "X", "XXTXTXX": "X"};
} catch { Engine.PATTERN8 = Engine.PATTERN8 || {}; }





// ================= SERVER WRAPPER =================
// Telegram bot implementation is embedded below; no separate telegram-bot.js needed.


function startTelegramBot(options) {
  const token = String(options.token || '').trim();
  const adminIds = new Set(String(options.adminIds || '').split(',').map(s => s.trim()).filter(Boolean));
  if (!token) return null;
  const apiRoot = `https://api.telegram.org/bot${token}`;
  let offset = 0;
  let stopped = false;

  async function tg(method, payload = {}) {
    const response = await fetch(`${apiRoot}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed (${response.status})`);
    return data.result;
  }
  const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: false, ...extra });
  const sendPhoto = (chat_id, photo, extra = {}) => tg('sendPhoto', { chat_id, photo, parse_mode: 'HTML', ...extra });
  const isAdmin = id => adminIds.has(String(id));
  const displayName = from => [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || 'Bạn';
  const plans = () => (options.getConfig().plans || []).filter(p => p.active !== false && Number(p.price) > 0 && Number(p.durationHours) > 0);
  const idShort = () => crypto.randomBytes(5).toString('hex').toUpperCase();
  const decodeHtmlEntities = (str) => String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } });
  const esc = s => String(decodeHtmlEntities(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmt = n => Number(n || 0).toLocaleString('vi-VN');
  const ensureHttps = u => { let s = String(u || '').trim(); if (!s) return ''; s = s.replace(/^http:\/\//i, 'https://'); if (!/^https:\/\//i.test(s)) s = 'https://' + s; try { const x = new URL(s); if (['localhost','127.0.0.1','::1'].includes(x.hostname.toLowerCase()) || x.hostname.toLowerCase().endsWith('.local')) return ''; return x.origin.replace(/\/+$/, ''); } catch (_) { return ''; } };

  // ─── USER MENU: command-first, no inline option keyboard ───────────────
  async function showStart(chatId, name, from) {
    const admin = isAdmin(from && from.id);
    if (!admin) return showUserMenu(chatId);
    const text = `╔════════════════════════════╗
║  <b>TOOLTUNGTUNG · ADMIN</b>  ║
╚════════════════════════════╝

👋 Xin chào <b>${esc(name)}</b>

🛠 Quản lý key, bảng giá, game, API, đơn hàng và góp ý tại Index Admin.
🌐 https://botvippro-production-0b00.up.railway.app/admin

💬 Hỗ trợ: <b>@SunNetWin</b>`;
    return send(chatId, text);
  }

  async function showUserMenu(chatId) {
    // Hướng dẫn dạng khung riêng, thao tác bằng lệnh; không dùng inline option buttons.
    const cfg = options.getConfig() || {};
    const needPhotos = Math.max(1, Number(cfg.groupTaskPhotos) || 3);
    const v2Hours = Math.max(0.25, Number(cfg.getkeyv2KeyHours) || 18);
    const promo = String(cfg.groupPromoText || '@SunNetWin tool dự đoán TX VIP').trim();
    const available = (cfg.plans || []).filter(p => p.active !== false && Number(p.price) > 0 && Number(p.durationHours) > 0);
    const priceLines = available.length ? available.map(p => {
      const duration = Number(p.durationHours) >= 24 ? `${Math.round(Number(p.durationHours) / 24)} ngày` : `${Number(p.durationHours)} giờ`;
      return `• <b>${esc(p.label)}</b> — <b>${fmt(p.price)}đ</b> · ${duration} · lệnh <code>/pay ${esc(p.id)}</code>`;
    }).join('\n') : 'Chưa có gói đang bán. Vui lòng thử lại sau.';
    const text =
`📚 <b>HƯỚNG DẪN SỬ DỤNG BOT</b>
━━━━━━━━━━━━━━━━━━━━
🔑 <b>/getkey · KEY DÙNG THỬ</b>
<blockquote>1️⃣ Đăng nội dung giới thiệu vào ${needPhotos} nhóm theo yêu cầu.
2️⃣ Chụp và gửi đủ ${needPhotos} ảnh cho bot.
3️⃣ Chờ Admin duyệt; key 15 phút sẽ được gửi sau khi duyệt.

📋 <b>Nội dung mẫu:</b>
<code>${esc(promo)}</code>
📌 Gõ: <code>/getkey</code></blockquote>

🔗 <b>/getkeyv2 · NHẬN KEY QUA LINK4M</b>
<blockquote>1️⃣ Gõ lệnh và mở link rút gọn bot gửi.
2️⃣ Hoàn thành bước xác nhận trên trang Link4M.
3️⃣ Lấy key tại trang xác nhận; nếu cần, gõ <code>done</code>.
⏱ Thời hạn key hiện tại: <b>${v2Hours} giờ</b>.
📌 Gõ: <code>/getkeyv2</code></blockquote>

💳 <b>/muakeytx · BẢNG GIÁ KEY</b>
<blockquote>${priceLines}

Để mua, gõ <code>/pay MÃ_GÓI</code> theo mã ở trên. Sau khi thanh toán, gửi bill theo hướng dẫn; key được cấp sau khi xác nhận.
📌 Gõ: <code>/muakeytx</code></blockquote>

🔐 <b>/nhapkey KEY</b>
<blockquote>Liên kết key với Telegram và nhận hướng dẫn mở Index.
Ví dụ: <code>/nhapkey ABCD-1234</code></blockquote>

🪪 <b>/mykey</b>
<blockquote>Xem key đã liên kết và thời gian còn lại.</blockquote>

🎵 <b>LỆNH TIKTOK</b>
<blockquote><b>/infotiktok username</b> — Xem thông tin kênh.
Ví dụ: <code>/infotiktok ngth.2010</code>
⏳ Cooldown: 30 giây.</blockquote>
<blockquote><b>/videotiktok link hoặc id</b> — Xem thông tin video.
Ví dụ: <code>/videotiktok https://www.tiktok.com/@tiktok/video/7231338487075638570</code>
⏳ Cooldown: 30 giây.</blockquote>

🏆 <b>/feedback</b>
<blockquote>Bước 1: gửi ảnh chụp kết quả/trải nghiệm.
Bước 2: gửi ghi chú ở tin nhắn tiếp theo.
Bot tự đính kèm tên, username và Telegram ID. Admin duyệt rồi mới đăng lên kênh.</blockquote>
❌ <b>/cancel</b> — Hủy thao tác đang thực hiện.

💬 Hỗ trợ: <b>@SunNetWin</b>`;
    return send(chatId, text);
  }

  async function sendHelpAdmin(chatId, page) {
    page = Number(page) || 1;
    const back = { reply_markup: { inline_keyboard: [
      [{ text: '📘 1·Tổng quan', callback_data: 'adm:dohelpadmin' }, { text: '🎮 2·Game', callback_data: 'adm:dohelpadmin2' }, { text: '🔑 3·Key/User', callback_data: 'adm:dohelpadmin3' }],
      [{ text: '◀️ Menu admin', callback_data: 'adm:home' }]
    ] } };
    if (page === 2) {
      return send(chatId, `🎮 <b>HELP 2 · GAME</b>
━━━━━━━━━━━━━━━
📋 <b>Xem</b>
• <code>/games</code> — danh sách game
• <code>/gamedetail id</code> — chi tiết 1 game
• <code>/gameerror</code> — game đang lỗi API
• <code>/testgame id</code> — thử gọi API

➕ <b>Thêm / xóa</b>
• <code>/addgame id parser url [nhãn]</code>
  VD: <code>/addgame sunwin_tx sunwin https://api... Sunwin TX</code>
  Parser: <code>sunwin|lc79|max789</code> 
• <code>/delgame id</code> — xóa game

🔗 <b>Link chơi (TX + Sicbo cùng cổng = 1 link)</b>
• <code>/setplayurl id url</code>
  Set 1 id → tự đồng bộ game cùng brand (vd sunwin)
• <code>/setgame id url</code> — đổi URL API feed

🏷 <b>Nhãn / nhóm</b>
• <code>/setlabel id tên</code>
• <code>/setparser id sunwin|lc79|max789</code>
• <code>/setgroup id tx|sicbo|md5</code>
• <code>/setbrand id brand</code> · <code>/seticon id url</code>

⚡ <b>Bật tắt</b>
• <code>/enablegame id</code> · <code>/disablegame id</code>
• <code>/enableall</code> · <code>/disableall</code>
• <code>/reloadgames</code> · <code>/resetengine id</code>`, back);
    }
    if (page === 3) {
      return send(chatId, `🔑 <b>HELP 3 · KEY · USER · HỆ THỐNG</b>
━━━━━━━━━━━━━━━
🔑 <b>Key</b>
• <code>/createkey giờ tb [gói]</code> — tạo key
  VD: <code>/createkey 24 3 VIP</code>
• <code>/givekey tgid giờ [tb]</code> — tạo + gửi user
• <code>/keys</code> · <code>/listkeys</code> · <code>/key id</code>
• <code>/findkey tgid|mã</code>
• <code>/extendkey id giờ</code> · <code>/delkey id</code>
• <code>/revoke id</code> · <code>/resetdevice id</code>
• <code>/activekeys</code> · <code>/expiredkeys</code> · <code>/clearkeys</code>
• <code>/setkeylimit id số</code> · <code>/setkeylabel id tên</code>

👤 <b>User</b>
• <code>/userinfo tgid|@user</code> — hồ sơ IP/TG
• <code>/topusers</code> · <code>/users</code> · <code>/orders</code>
• <code>/pending</code> — chờ duyệt (+ nút)
• <code>/approve id</code> · <code>/reject id</code>
• <code>/approveall</code> · <code>/rejectall</code>

💳 <b>Gói & bank (hiện ở Cửa hàng index)</b>
• <code>/plans</code>
• <code>/addplan id nhãn giá giờ</code>
  VD: <code>/addplan vip1 VIP-1N 50000 24</code>
• <code>/delplan id</code> · <code>/toggleplan id</code>
• <code>/setplanprice id giá</code>
• <code>/setplanduration id giờ</code>
• <code>/setbank NH STK chủ</code>

⚙️ <b>Hệ thống</b>
• <code>/settings</code> · <code>/setpoll ms</code>
• <code>/setmaxdevices số</code>
• <code>/setmaint on|off [nội dung]</code>
• <code>/setannounce ...</code> · <code>/setsupport url</code>
• <code>/broadcast nội dung</code>
• <code>/logs</code> · <code>/ping</code> · <code>/stats</code>
• <code>/admin</code> — bảng nút`, back);
    }
    return send(chatId, `⚙️ <b>HELP 1 · TỔNG QUAN ADMIN</b>
━━━━━━━━━━━━━━━
🛠 Bảng nút nhanh: <code>/admin</code>

🎮 <b>Game</b> → xem /helpadmin2
• Thêm game, set API, set link chơi
• 1 cổng (Sunwin) TX+Sicbo <b>chung 1 playUrl</b>

🔑 <b>Key & User</b> → /helpadmin3
• Tạo key, duyệt nhiệm vụ, xem IP user

💳 <b>Cửa hàng</b>
• <code>/addplan</code> · <code>/setplanprice</code>
• User bấm gói trên web → mở bot

📢 <b>Thông báo / site</b>
• <code>/setannounce</code> · <code>/setsitetitle</code>
• <code>/setwatermark</code> · <code>/setsupport</code>

📌 Gõ <code>/helpadmin2</code> hoặc <code>/helpadmin3</code> để xem chi tiết + ví dụ.`, back);
  }


  async function showAdminHelp(chatId, page) {
    page = page || 'home';
    const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
    if (page === 'home') {
      return send(chatId,
        '🛠 <b>BẢNG ĐIỀU KHIỂN ADMIN</b>\n━━━━━━━━━━━━━━━\nChọn nhóm bên dưới — hoặc gõ lệnh text.\nUser vẫn dùng lệnh bình thường.',
        kb([
          [{ text: '📩 Yêu cầu', callback_data: 'adm:req' }, { text: '🔑 Key', callback_data: 'adm:keys' }],
          [{ text: '🎮 Game', callback_data: 'adm:games' }, { text: '💳 Gói & Bank', callback_data: 'adm:plans' }],
          [{ text: '⚙️ Hệ thống', callback_data: 'adm:sys' }, { text: '📢 Site / Bot', callback_data: 'adm:site' }],
          [{ text: '📊 Stats', callback_data: 'adm:dostats' }, { text: '👥 Users', callback_data: 'adm:dousers' }],
          [{ text: '📜 Logs', callback_data: 'adm:dologs' }, { text: '🏓 Ping', callback_data: 'adm:doping' }],
          [{ text: '📘 Lệnh text đầy đủ', callback_data: 'adm:cmds' }]
        ])
      );
    }
    if (page === 'req') {
      return send(chatId, '📩 <b>YÊU CẦU</b>\n• Nút nhanh bên dưới\n• Lệnh: /pending /approve /reject /approveall /rejectall /orders', kb([
        [{ text: '📩 Xem pending', callback_data: 'adm:pending' }, { text: '✅ Duyệt tất cả', callback_data: 'adm:approveall' }],
        [{ text: '🗑️ Từ chối tất cả', callback_data: 'adm:rejectall' }, { text: '💳 Orders', callback_data: 'adm:doorders' }],
        [{ text: '◀️ Menu admin', callback_data: 'adm:home' }]
      ]));
    }
    if (page === 'keys') {
      return send(chatId, '🔑 <b>KEY</b>\nLệnh:\n<code>/createkey 24 3 VIP</code>\n<code>/givekey tgid 24 3</code>\n<code>/findkey tgid</code>\n<code>/key id</code> · /delkey · /extendkey · /revoke', kb([
        [{ text: '📋 List keys', callback_data: 'adm:dokeys' }, { text: '✅ Active', callback_data: 'adm:doactive' }],
        [{ text: '⏰ Expired', callback_data: 'adm:doexpired' }, { text: '🧹 Clear expired', callback_data: 'adm:doclearkeys' }],
        [{ text: '◀️ Menu admin', callback_data: 'adm:home' }]
      ]));
    }
    if (page === 'games') {
      return send(chatId, '🎮 <b>GAME</b>\n<code>/games</code> · <code>/gamedetail id</code>\n<code>/addgame id parser url [nhãn]</code>\n<code>/setgame id url</code> · /setplayurl · /testgame\nParser: sunwin|lc79|max789', kb([
        [{ text: '📋 Danh sách', callback_data: 'adm:dogames' }, { text: '⚠️ Lỗi API', callback_data: 'adm:dogameerr' }],
        [{ text: '✅ Bật all', callback_data: 'adm:doenableall' }, { text: '🔒 Tắt all', callback_data: 'adm:dodisableall' }],
        [{ text: '♻️ Reload', callback_data: 'adm:doreload' }],
        [{ text: '◀️ Menu admin', callback_data: 'adm:home' }]
      ]));
    }
    if (page === 'plans') {
      return send(chatId, '💳 <b>GÓI & BANK</b>\n<code>/plans</code>\n<code>/addplan id nhãn giá giờ</code>\n<code>/setbank NH STK chủ</code>\n<code>/setplanprice id giá</code>', kb([
        [{ text: '📦 Xem gói', callback_data: 'adm:doplans' }, { text: '🏦 Xem bank', callback_data: 'adm:dobank' }],
        [{ text: '◀️ Menu admin', callback_data: 'adm:home' }]
      ]));
    }
    if (page === 'sys') {
      return send(chatId, '⚙️ <b>HỆ THỐNG</b>\n<code>/settings</code>\n<code>/setmaint on|off</code>\n<code>/setpoll ms</code> · /setmaxdevices\n<code>/lockcmd getkey</code>', kb([
        [{ text: '⚙️ Settings', callback_data: 'adm:dosettings' }, { text: '🛠 Bảo trì ON', callback_data: 'adm:mainton' }],
        [{ text: '✅ Bảo trì OFF', callback_data: 'adm:maintoff' }],
        [{ text: '◀️ Menu admin', callback_data: 'adm:home' }]
      ]));
    }
    if (page === 'site') {
      return send(chatId, '📢 <b>SITE / BOT</b>\n<code>/setannounce ...</code>\n<code>/setpromo ...</code> · /settask\n<code>/setwatermark</code> · /setsitetitle · /setsupport', kb([
        [{ text: '📣 Xem announce', callback_data: 'adm:doannounce' }],
        [{ text: '◀️ Menu admin', callback_data: 'adm:home' }]
      ]));
    }
    if (page === 'cmds') {
      return send(chatId, '📘 <b>LỆNH TEXT ĐẦY ĐỦ</b>\nBấm nút bên dưới để xem menu (hoặc gõ /helpadmin).', kb([
        [{ text: '📘 helpadmin', callback_data: 'adm:dohelpadmin' }, { text: '📘 help 2', callback_data: 'adm:dohelpadmin2' }],
        [{ text: '📘 help 3', callback_data: 'adm:dohelpadmin3' }],
        [{ text: '◀️ Menu admin', callback_data: 'adm:home' }]
      ]));
    }
    return showAdminHelp(chatId, 'home');
  }

  async function notifyAdmins(request, proofFileId) {
    if (!adminIds.size) return;
    const planText = request.type === 'payment'
      ? `💎 ${esc(request.planLabel)} · ${fmt(request.price)}đ · ${request.durationHours}h`
      : request.type === 'reset' ? '🔄 Reset thiết bị'
      : request.type === 'feedback' ? '🏆 Chia sẻ trải nghiệm người dùng'
      : request.type === 'trial' ? '🎁 Duyệt key dùng thử · 15 phút' : '🎁 Key free (nhiệm vụ)';
    let profileBlock = '';
    try {
      if (typeof userProfiles !== 'undefined' && request.telegramId && userProfiles[String(request.telegramId)]) {
        const p = userProfiles[String(request.telegramId)];
        profileBlock = `\n📡 IP: <code>${esc(p.lastIp || '—')}</code>\n🖥 UA: <code>${esc(String(p.lastUa || '—').slice(0, 80))}</code>\n🌐 Lang: ${esc(p.languageCode || '—')} · Premium: ${p.isPremium ? 'yes' : 'no'}`;
      }
    } catch (e) {}
    const text =
`📩 <b>YÊU CẦU MỚI</b> #${request.id}
────────────────────
👤 ${esc(request.userName)} (@${esc(request.username || '—')})
🆔 <code>${request.telegramId}</code>
📦 ${planText}
📷 Ảnh: <b>${(request.proofFileIds && request.proofFileIds.length) || (proofFileId ? 1 : 0)}</b>${profileBlock}
${request.groupLink ? '🔗 ' + esc(request.groupLink) + '\n' : ''}${request.caption ? '💬 ' + esc(String(request.caption).slice(0, 120)) + '\n' : ''}
Bấm nút duyệt / từ chối:`;
    const keyboard = {
      inline_keyboard: [[
        { text: '🛠 Mở Index Admin để xử lý', url: 'https://botvippro-production-0b00.up.railway.app/admin' }
      ]]
    };
    const ids = Array.isArray(request.proofFileIds) && request.proofFileIds.length
      ? request.proofFileIds.slice(0, 10)
      : (proofFileId ? [proofFileId] : []);
    for (const aid of adminIds) {
      try {
        if (ids.length >= 2) {
          // Gộp tất cả ảnh thành 1 album — không spam từng ảnh
          const media = ids.map((fid, i) => ({
            type: 'photo',
            media: fid,
            caption: i === 0 ? (`📷 Bộ ảnh nhiệm vụ #${request.id} · ${ids.length} ảnh`) : undefined,
            parse_mode: i === 0 ? 'HTML' : undefined
          }));
          await tg('sendMediaGroup', { chat_id: aid, media });
          await send(aid, text, { reply_markup: keyboard });
        } else if (ids.length === 1) {
          await sendPhoto(aid, ids[0], { caption: text, reply_markup: keyboard });
        } else {
          await send(aid, text, { reply_markup: keyboard });
        }
      } catch (e) {
        console.warn('[telegram] notify admin fail', aid, e.message);
        try { await send(aid, text, { reply_markup: keyboard }); } catch (e2) {}
      }
    }
  }

  async function deliverReviewedKey(result, chatIdForReview) {
    if (!result || !result.ok || !result.request) return;
    const req = result.request;
    if (req.type === 'reset') {
      try {
        await send(req.telegramId,
`✅ <b>RESET THÀNH CÔNG</b>
────────────────
🔑 Key đã được xóa hết thiết bị cũ.
📱 Giờ đăng nhập lại tối đa <b>3 máy</b>.`);
        if (options.markDelivered) options.markDelivered(req.id);
      } catch (e) {
        if (chatIdForReview) await send(chatIdForReview, `Đã reset nhưng chưa gửi được tin cho user: ${e.message}`).catch(() => null);
      }
      return;
    }
    if (!result.key) return;
    const expiresText = req.durationHours > 0
      ? new Date(Date.now() + req.durationHours * 3600000).toLocaleString('vi-VN')
      : 'Không hết hạn';
    const text = '<b>✅ KEY SẴN SÀNG</b>\n'
      + '────────────────────\n'
      + '🔑 <code>' + result.key + '</code>\n\n'
      + '📦 ' + esc(req.planLabel || 'Key free') + '\n'
      + '⏱ ' + (req.durationHours > 0 ? req.durationHours + 'h' : 'Vĩnh viễn') + '\n'
      + '📅 ' + expiresText + '\n'
      + '💾 Key lưu trên thiết bị sau khi kích hoạt\n\n'
      + '────────────────────\n'
      + '🌐 Mở Mini App và nhập key\n'
      + '💬 Hỗ trợ: @SunNetWin';
    try {
      await send(req.telegramId, text);
      if (options.markDelivered) options.markDelivered(req.id);
    } catch (e) {
      console.warn('[telegram] deliver key fail', req.telegramId, e.message);
      if (chatIdForReview) await send(chatIdForReview, `Duyệt OK nhưng chưa gửi key: ${e.message}`).catch(() => null);
    }
  }

  async function createProofRequest(message, mode) {
    const from = message.from || {};
    const userId = String(from.id);
    const sessions = options.getSessions();
    const session = sessions[userId];
    if (!session || (session.type !== mode && !(mode === 'feedback' && session.type === 'feedback_photo'))) {
      await send(message.chat.id, '⚠️ Gõ /getkey, /muakeytx hoặc /feedback trước khi gửi ảnh.');
      return;
    }
    const photos = message.photo || [];
    if (!photos.length) return;
    const caption = String(message.caption || '').trim();
    const fileId = photos[photos.length - 1].file_id;
    const cfg = options.getConfig();
    const need = mode === 'group' ? (Number(cfg.groupTaskPhotos) || 3) : 1;
    const timeoutSec = Number(cfg.groupTaskTimeoutSec) || 300;

    // Timeout check for group task
    if (mode === 'group' && session.startedAt && (Date.now() - session.startedAt) > timeoutSec * 1000) {
      delete sessions[userId]; options.saveSessions(sessions);
      await send(message.chat.id, `⏰ Hết ${timeoutSec} giây. Gõ /getkey để làm lại.`);
      return;
    }

    if (mode === 'feedback') {
      // Bước 1: chỉ nhận ảnh. Ghi chú được thu ở tin nhắn tiếp theo để trải nghiệm rõ ràng hơn.
      const photoUniqueId = String(photos[photos.length - 1].file_unique_id || fileId);
      sessions[userId] = {
        type: 'feedback_note', startedAt: session.startedAt || Date.now(),
        proofFileId: fileId, proofFileIds: [fileId], photoUniqueId,
        telegramId: userId, username: from.username || '', userName: displayName(from)
      };
      options.saveSessions(sessions);
      await send(message.chat.id, '✅ <b>BƯỚC 1/2 · ĐÃ NHẬN ẢNH</b>\n\n📝 <b>BƯỚC 2/2 · GỬI GHI CHÚ</b>\nHãy gửi một tin nhắn ngắn mô tả trải nghiệm hoặc kết quả bạn muốn chia sẻ. Ví dụ: “Mình thích phần lịch sử theo phiên, dễ theo dõi hơn.”\n\n👤 Bot sẽ đính kèm tên và tài khoản Telegram của bạn để Admin xác minh. Bài chỉ đăng lên kênh sau khi được duyệt.\n❌ Gõ /cancel để hủy.');
      return;
    }

    if (mode === 'group') {
      session.proofs = session.proofs || [];
      const photoUniqueId = String(photos[photos.length - 1].file_unique_id || fileId);
      if (session.proofs.some(p => String(p.uniqueId || p.fileId) === photoUniqueId)) {
        await send(message.chat.id, '⚠️ Ảnh này đã được gửi trong nhiệm vụ. Hãy gửi ảnh minh chứng khác.');
        return;
      }
      session.proofs.push({ fileId, uniqueId: photoUniqueId, caption, at: Date.now() });
      options.saveSessions(sessions);
      const have = session.proofs.length;
      if (have < need) {
        await send(message.chat.id,
`📷 Ảnh <b>${have}/${need}</b>
⏳ Còn <b>${need - have}</b> ảnh
⌛️ ~${Math.max(0, Math.ceil((timeoutSec * 1000 - (Date.now() - session.startedAt)) / 1000))}s`);
        return;
      }
      // Đủ ảnh chỉ tạo yêu cầu. Key 15 phút chỉ được phát sau khi Admin duyệt.
      const trialDay = bangkokDayKey();
      const used = trialUses[String(userId)];
      if (used && used.day === trialDay) {
        delete sessions[userId]; options.saveSessions(sessions);
        await send(message.chat.id, '⛔ Telegram ID này đã gửi yêu cầu dùng thử hôm nay. Nếu đang chờ duyệt, vui lòng đợi thông báo từ bot.');
        return;
      }
      for (const [id, entry] of Object.entries(trialUses)) {
        if (!entry || !entry.day || entry.day < bangkokDayKey(Date.now() - 14 * 86400000)) delete trialUses[id];
      }
      const request = {
        id: idShort(), type: 'trial', status: 'pending',
        telegramId: userId, username: from.username || '', userName: displayName(from),
        planLabel: 'Key dùng thử 15 phút', durationHours: 0.25, deviceLimit: 1,
        proofFileIds: session.proofs.map(p => p.fileId).slice(0, 10),
        proofFileId: session.proofs.length ? session.proofs[session.proofs.length - 1].fileId : fileId,
        caption: caption || 'Ảnh minh chứng nhiệm vụ', createdAt: Date.now()
      };
      trialUses[String(userId)] = { day: trialDay, status: 'pending', requestId: request.id, submittedAt: Date.now() };
      saveJSON(TRIAL_FILE, trialUses);
      options.addRequest(request);
      delete sessions[userId]; options.saveSessions(sessions);
      await send(message.chat.id, `✅ Đã gửi đủ ảnh nhiệm vụ (#${request.id}). Key 15 phút sẽ được gửi sau khi Admin duyệt. Bạn không cần gửi lại ảnh.`);
      await notifyAdmins(request, request.proofFileId);
      return;
    }

    // payment mode — 1 ảnh
    let plan = plans().find(p => p.id === session.planId);
    if (!plan) {
      delete sessions[userId]; options.saveSessions(sessions);
      await send(message.chat.id, '⚠️ Gói hết hạn. Gõ /muakeytx chọn lại.');
      return;
    }
    const request = {
      id: idShort(), type: 'payment', status: 'pending',
      telegramId: userId, username: from.username || '', userName: displayName(from),
      groupLink: '', caption, proofFileId: fileId,
      planId: plan.id, planLabel: plan.label || 'Key VIP', orderId: String(session.orderId || ''),
      price: Number(plan.price || 0), durationHours: Number(plan.durationHours || 5),
      createdAt: Date.now()
    };
    options.addRequest(request);
    delete sessions[userId]; options.saveSessions(sessions);
    await send(message.chat.id, `✅ Bill đã gửi · <b>#${request.id}</b>\n⏳ Admin duyệt → nhận key`);
    await notifyAdmins(request, request.proofFileId);
  }

  function startGroupKeyTask(chatId, fromId, from) {
    const trialDay = bangkokDayKey();
    const priorTrial = trialUses[String(fromId)];
    if (priorTrial && priorTrial.day === trialDay) {
      const msg = priorTrial.status === 'pending'
        ? 'Yêu cầu dùng thử của bạn đang chờ Admin duyệt.'
        : priorTrial.status === 'rejected'
          ? 'Yêu cầu dùng thử hôm nay chưa được duyệt. Bạn có thể gửi yêu cầu mới sau 00:00.'
          : 'Bạn đã nhận key dùng thử hôm nay.';
      return send(chatId, '⛔ ' + msg + '\n\n💎 Mua key: /muakeytx · 🔑 /mykey');
    }
    const cfg = options.getConfig();
    const sessions = options.getSessions();
    const timeoutSec = Number(cfg.groupTaskTimeoutSec) || 300;
    const need = Number(cfg.groupTaskPhotos) || 3;
    const task = String(cfg.groupTaskText || 'Làm nhiệm vụ theo yêu cầu admin.');
    const promo = String(cfg.groupPromoText || '');
    sessions[fromId] = { type: 'group', startedAt: Date.now(), proofs: [] };
    options.saveSessions(sessions);
    return send(chatId,
`📸 <b>Nhiệm vụ quảng cáo bot:</b>

${esc(task)}

${promo ? `📌 <b>Câu cần sao chép:</b>\n<code>${esc(promo)}</code>\n` : ''}
📷 Gửi đủ <b>${need} ảnh</b> chứng minh vào đây
⌛️ Bạn có <b>${timeoutSec} giây</b> để gửi ảnh.
🎁 Key dùng thử: <b>15 phút · 1 Telegram ID/ngày</b>`);
  }

  // ===== /getkeyv2 — tạo link rút gọn Link4M, giới hạn 2 lần/ngày, Index Key 30 phút =====
  /** Gọi API Link4M rút gọn: GET https://link4m.co/api-shorten/v2?api=TOKEN&url=DEST */
  async function createLink4mShortUrl(destinationUrl, apiToken, configuredBaseUrl) {
    const token = String(apiToken || '').trim();
    if (!token) throw new Error('Chưa cấu hình Link4M API token');
    const dest = String(destinationUrl || '').trim();
    if (!dest || !/^https:\/\//i.test(dest)) throw new Error('URL đích phải là HTTPS hợp lệ');
    // Chỉ gửi token tới host Link4M đã được cho phép; không cho settings biến thành SSRF.
    let apiBase = String(configuredBaseUrl || 'https://link4m.co/api-shorten/v2').trim();
    if (!apiBase) apiBase = 'https://link4m.co/api-shorten/v2';
    if (!/^https:\/\//i.test(apiBase)) apiBase = 'https://' + apiBase.replace(/^\/+/, '');
    let parsed;
    try { parsed = new URL(apiBase); } catch (_) { throw new Error('Link4M API URL không hợp lệ'); }
    const host = parsed.hostname.toLowerCase();
    if (!['link4m.co', 'www.link4m.co', 'link4m.com', 'www.link4m.com'].includes(host)) {
      throw new Error('Link4M API URL chỉ được dùng host link4m.co hoặc link4m.com');
    }
    if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/api-shorten/v2';
    const apiUrl = new URL(parsed.toString());
    apiUrl.searchParams.set('api', token);
    apiUrl.searchParams.set('url', dest);
    const r = await fetch(apiUrl.toString(), {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'ToolTungTung/1.0' },
      signal: AbortSignal.timeout(15000)
    });
    const bodyText = await r.text();
    let data = null;
    try { data = JSON.parse(bodyText); } catch (_) {}
    if (!r.ok) throw new Error((data && (data.message || data.error)) || ('Link4M HTTP ' + r.status));
    if (!data || String(data.status).toLowerCase() !== 'success' || !data.shortenedUrl) {
      throw new Error((data && (data.message || data.error)) || 'Link4M không trả shortenedUrl');
    }
    let shortUrl;
    try { shortUrl = new URL(String(data.shortenedUrl).trim()); } catch (_) { throw new Error('Link4M trả về URL rút gọn không hợp lệ'); }
    if (!['http:', 'https:'].includes(shortUrl.protocol)) throw new Error('Link4M trả về URL không an toàn');
    return shortUrl.toString();
  }

  async function startGetkeyV2(chatId, fromId, from) {
    const cfg = options.getConfig() || {};
    const maxPerDay = Number(cfg.getkeyv2MaxPerDay) || 2;
    const linkTtlMin = Number(cfg.getkeyv2LinkMinutes) || 5;
    const keyTtlHours = Number(cfg.getkeyv2KeyHours) || 18;
    const day = bangkokDayKey();
    const uid = String(fromId);
    let rec = getkeyv2Uses[uid];
    if (!rec || rec.day !== day) {
      rec = { day, count: 0 };
      getkeyv2Uses[uid] = rec;
    }
    if (rec.count >= maxPerDay) {
      return send(chatId, `⛔ Hôm nay bạn đã vượt đủ <b>${maxPerDay} lần</b>, quay lại ngày mai.\n\n💎 Mua key lâu dài: /muakeytx`);
    }
    // Cancel the previous pending link completely (including its code index).
    const previousPending = pendingLink4m[uid];
    if (previousPending) {
      try { clearTimeout(previousPending.timer); } catch (e) {}
      if (previousPending.trackCode) delete pendingLink4mByCode[previousPending.trackCode];
      delete pendingLink4m[uid];
    }

    const trackCode = crypto.randomBytes(6).toString('hex');
    // Link đích = API server. Link4M chỉ redirect về đây SAU KHI user vượt xong → biết chắc đã vượt.
    const publicBase = ensureHttps(process.env.PUBLIC_URL || process.env.WEB_URL || cfg.publicUrl || '').replace(/\/+$/, '');
    if (!publicBase) {
      return send(chatId, '⚠️ Dịch vụ nhận key đang tạm gián đoạn. Vui lòng thử lại sau hoặc liên hệ @SunNetWin.');
    }
    const destUrl = publicBase + '/api/link4m/pass?c=' + encodeURIComponent(trackCode) + '&u=' + encodeURIComponent(uid);

    const apiToken = String(cfg.link4mApiToken || process.env.LINK4M_API_TOKEN || '').trim();
    let shortLink = '';
    try {
      if (!apiToken) {
        logLine('[getkeyv2] unavailable: Link4M token is not configured');
        return send(chatId, '⚠️ Chức năng tạo link đang tạm chưa sẵn sàng. Vui lòng thử lại sau hoặc liên hệ @SunNetWin.');
      }
      await send(chatId, '⏳ Đang tạo link vượt Link4M...');
      shortLink = await createLink4mShortUrl(destUrl, apiToken, cfg.link4mBaseUrl);
    } catch (e) {
      logLine('[getkeyv2] Link4M create failed: ' + String(e && e.message || 'unknown').slice(0, 300));
      return send(chatId, '❌ Chưa tạo được link lúc này. Vui lòng thử lại sau hoặc liên hệ @SunNetWin.');
    }

    const expiresAt = Date.now() + linkTtlMin * 60 * 1000;
    const sessions = options.getSessions();
    sessions[uid] = { type: 'getkeyv2', startedAt: Date.now(), trackCode, shortLink, expiresAt, verified: false };
    options.saveSessions(sessions);

    const timer = setTimeout(async () => {
      try {
        const current = pendingLink4m[uid];
        if (current && current.trackCode === trackCode) {
          const hadVerified = !!(current.verified || current.keySent || current.plainKey);
          delete pendingLink4m[uid];
          delete pendingLink4mByCode[trackCode];
          const s = options.getSessions();
          if (s[uid] && s[uid].type === 'getkeyv2' && s[uid].trackCode === trackCode) {
            delete s[uid];
            options.saveSessions(s);
          }
          if (!hadVerified) await send(chatId, `⏰ Link đã hết hạn sau ${linkTtlMin} phút. Gõ /getkeyv2 để tạo link mới.`).catch(() => null);
        }
      } catch (e) {}
    }, linkTtlMin * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();

    const pending = {
      trackCode, shortLink, expiresAt, chatId, timer, fromId: uid,
      verified: false, verifiedAt: null, keySent: false
    };
    pendingLink4m[uid] = pending;
    pendingLink4mByCode[trackCode] = pending;
    // Cho HTTP callback gọi phát key
    completeGetkeyV2Hook = completeGetkeyV2;

    await send(chatId,
`🔗 <b>GET KEY V2 · Link4M</b>
━━━━━━━━━━━━━━━━━━━━
📌 Link vượt (hiệu lực <b>${linkTtlMin} phút</b>):
${esc(shortLink)}

✅ Mở link và <b>vượt hết quảng cáo</b>.
Hệ thống <b>tự biết</b> khi bạn vượt xong (mở trang xác nhận) và gửi key tại đây.

Nếu đã vượt mà chưa thấy key: gõ <code>done</code>.
⏳ Link hiệu lực <b>${linkTtlMin} phút</b> · Key sống <b>${keyTtlHours} giờ</b>
━━━━━━━━━━━━━━━━━━━━
@SunNetWin`);
  }

  async function completeGetkeyV2(chatId, fromId, opts = {}) {
    const uid = String(fromId);
    const sessions = options.getSessions();
    const sess = sessions[uid];
    if (!sess || sess.type !== 'getkeyv2') {
      return send(chatId, '⚠️ Không có phiên getkeyv2 đang mở. Gõ /getkeyv2 trước.');
    }
    if (sess.expiresAt && sess.expiresAt < Date.now()) {
      delete sessions[uid];
      options.saveSessions(sessions);
      if (pendingLink4m[uid]) {
        try { clearTimeout(pendingLink4m[uid].timer); } catch(e){}
        try { delete pendingLink4mByCode[pendingLink4m[uid].trackCode]; } catch(e){}
        delete pendingLink4m[uid];
      }
      return send(chatId, '⏰ Link đã hết hạn. Gõ /getkeyv2 để tạo mới.');
    }
    // Bắt buộc đã vượt: callback /api/link4m/pass đánh dấu verified
    const pending = pendingLink4m[uid];
    const verified = !!(sess.verified || (pending && pending.verified) || opts.forceVerified);
    if (!verified) {
      return send(chatId, '❌ <b>Chưa phát hiện vượt link</b>.\nMở đúng link bot gửi → vượt hết quảng cáo đến trang xác nhận.\nSau đó key sẽ được gửi tự động (hoặc gõ lại <code>done</code>).');
    }
    if (pending && pending.keySent) {
      return send(chatId, '✅ Key đã gửi rồi. Kéo lên tin nhắn trước đó để lấy key.');
    }
    const cfg = options.getConfig() || {};
    const maxPerDay = Number(cfg.getkeyv2MaxPerDay) || 2;
    const keyTtlHours = Number(cfg.getkeyv2KeyHours) || 18;
    const day = bangkokDayKey();
    let rec = getkeyv2Uses[uid];
    if (!rec || rec.day !== day) {
      rec = { day, count: 0 };
      getkeyv2Uses[uid] = rec;
    }
    if (rec.count >= maxPerDay) {
      return send(chatId, `⛔ Hôm nay bạn đã vượt đủ ${maxPerDay} lần.`);
    }

    // ===== Tạo key THẬT trước (để chắc chắn login được) =====
    let plainKey = null;
    let indexKey = genIndexKey();
    try {
      if (typeof options.createKey === 'function') {
        const issued = options.createKey({
          label: `Index Key · ${keyTtlHours}h · TG ${uid}`,
          durationHours: keyTtlHours,
          deviceLimit: 1,
          source: 'getkeyv2',
          telegramId: uid
        });
        plainKey = issued && issued.plainKey;
      }
    } catch (e) {
      logLine && logLine('getkeyv2 createKey fail: ' + (e.message || e));
    }
    // Nếu createKey lỗi → dùng Index Key dạng plain luôn
    if (!plainKey) {
      plainKey = indexKey;
      try {
        if (typeof options.createKey === 'function') {
          const issued2 = options.createKey({
            key: plainKey,
            label: `Index Key · ${keyTtlHours}h · TG ${uid}`,
            durationHours: keyTtlHours,
            deviceLimit: 1,
            source: 'getkeyv2-idx',
            telegramId: uid
          });
          plainKey = (issued2 && issued2.plainKey) || plainKey;
        }
      } catch (e2) { /* keep plainKey = indexKey */ }
    }

    // Đăng ký Index Key map (auth cũng nhận IDX-...)
    const expiresAt = Date.now() + keyTtlHours * 60 * 60 * 1000;
    indexKeys[indexKey] = {
      telegramId: uid,
      createdAt: Date.now(),
      expiresAt,
      used: false,
      deviceHash: null,
      plainKey: plainKey
    };
    // Nếu plainKey khác IDX, cũng map để auth nhận
    if (plainKey && plainKey !== indexKey) {
      indexKeys[String(plainKey).toUpperCase()] = {
        telegramId: uid, createdAt: Date.now(), expiresAt, used: false, deviceHash: null, plainKey
      };
    }
    saveIndexKeys();

    rec.count += 1;
    saveGetkeyv2Uses();

    // cleanup session + đánh dấu đã gửi key
    if (pendingLink4m[uid]) {
      pendingLink4m[uid].keySent = true;
      try { clearTimeout(pendingLink4m[uid].timer); } catch (e) {}
      try { delete pendingLink4mByCode[pendingLink4m[uid].trackCode]; } catch (e) {}
      delete pendingLink4m[uid];
    }
    delete sessions[uid];
    options.saveSessions(sessions);

    const appUrl = ensureHttps(process.env.PUBLIC_URL || process.env.WEB_URL || '').replace(/\/+$/, '') + '/';
    // Nút copy_text (Telegram hỗ trợ) + mở Index
    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 Sao chép Key', copy_text: { text: String(plainKey) } }],
        [{ text: '🎮 Mở Index dán Key', web_app: { url: appUrl } }]
      ]
    };
    await send(chatId,
`🎉 <b>VƯỢT THÀNH CÔNG</b>
━━━━━━━━━━━━━━━━━━━━
🔑 <b>KEY DÙNG CHO INDEX</b>

<code>${esc(plainKey)}</code>

⏱ Hết hạn: <b>${keyTtlHours} giờ</b> · 1 thiết bị

📋 <b>Cách vào Index:</b>
1. Bấm <b>📋 Sao chép Key</b> (hoặc giữ dòng key ở trên)
2. Bấm <b>🎮 Mở Index dán Key</b>
3. Dán vào ô <b>DÁN KEY VÀO ĐÂY</b> → <b>UNLOCK</b>

━━━━━━━━━━━━━━━━━━━━
Lượt còn lại hôm nay: <b>${Math.max(0, maxPerDay - rec.count)}</b>/${maxPerDay}
@SunNetWin`,
      { reply_markup: keyboard }
    );
    // Tin phụ: chỉ key thuần — dễ copy trên mọi máy
    await send(chatId, '<code>' + esc(plainKey) + '</code>').catch(() => null);
  }
  // HTTP /api/link4m/pass gọi hook này để tự phát key sau khi user vượt
  completeGetkeyV2Hook = completeGetkeyV2;

  function resolveKey(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    const list = options.getKeys ? options.getKeys() : [];
    let k = list.find(x => x.id === q || String(x.id).toLowerCase() === q.toLowerCase());
    if (k) return k;
    if (options.findKey) return options.findKey(q);
    return null;
  }

  // ─── TikTok / Facebook lookup ───────────────────────────
  async function lookupTikTok(input) {
    let username = String(input || '').trim();
    const urlMatch = username.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i);
    if (urlMatch) username = urlMatch[1];
    username = username.replace(/^@/, '').split(/[/?#\s]/)[0];
    if (!username || username.length < 2) throw new Error('Username/link không hợp lệ.');
    const profileUrl = `https://www.tiktok.com/@${username}`;
    const headers = {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8'
    };
    let info = {
      username, nickname: username, avatar: '', bio: '', verified: false, private: false,
      followers: null, following: null, likes: null, videos: null, createTime: null, profileUrl
    };
    // 1) oEmbed — nickname + thumb
    try {
      const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(profileUrl)}`;
      const r = await fetch(oembedUrl, { signal: AbortSignal.timeout(8000), headers });
      if (r.ok) {
        const d = await r.json();
        info.nickname = d.author_name || d.title || username;
        info.avatar = d.thumbnail_url || '';
        info.bio = (d.title || '').slice(0, 200);
      }
    } catch {}
    // 2) HTML page — SIGI_STATE / universal data for stats
    try {
      const page = await fetch(profileUrl, { signal: AbortSignal.timeout(12000), headers });
      if (page.ok) {
        const html = await page.text();
        let jsonStr = null;
        const m1 = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
        const m2 = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
        if (m1) jsonStr = m1[1];
        else if (m2) jsonStr = m2[1];
        if (jsonStr) {
          const data = JSON.parse(jsonStr);
          // try multiple paths
          let user = null;
          const def = data?.__DEFAULT_SCOPE__ || data;
          const detail = def?.['webapp.user-detail'] || def?.UserModule || def;
          if (detail?.userInfo?.user) user = detail.userInfo;
          else if (detail?.users) {
            const first = Object.values(detail.users)[0];
            if (first) user = { user: first, stats: detail.stats?.[first.id] || detail.statsList?.[first.id] };
          }
          if (user?.user) {
            const u = user.user;
            const s = user.stats || {};
            info.nickname = u.nickname || info.nickname;
            info.avatar = u.avatarLarger || u.avatarMedium || u.avatarThumb || info.avatar;
            info.bio = u.signature || info.bio;
            info.verified = !!u.verified;
            info.private = !!u.privateAccount;
            info.followers = s.followerCount ?? null;
            info.following = s.followingCount ?? null;
            info.likes = s.heartCount ?? s.heart ?? null;
            info.videos = s.videoCount ?? null;
            if (u.createTime) info.createTime = Number(u.createTime) * (String(u.createTime).length <= 10 ? 1000 : 1);
          }
        }
      }
    } catch {}
    if (!info.nickname && !info.avatar) throw new Error('Không lấy được info (user ẩn / không tồn tại).');
    return info;
  }

    async function lookupFacebook(input) {
    let raw = String(input || '').trim();
    let url = raw;
    if (!/^https?:\/\//i.test(raw)) {
      raw = raw.replace(/^@/, '').replace(/^facebook\.com\//i, '');
      url = 'https://www.facebook.com/' + encodeURIComponent(raw.split(/[/?#]/)[0]);
    }
    // share/reel/watch → giữ nguyên url
    const headers = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
    };
    const decode = (t) => {
      return String(t || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
        .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } })
        .replace(/\s+/g, ' ')
        .trim();
    };
    const info = {
      url, author: '', avatar: '', bio: '', type: 'profile',
      followers: null, likes: null, provider: 'Facebook'
    };
    try {
      const oembed = 'https://www.facebook.com/plugins/post/oembed.json?url=' + encodeURIComponent(url);
      const r = await fetch(oembed, { signal: AbortSignal.timeout(10000), headers });
      if (r.ok) {
        const d = await r.json();
        info.author = decode(d.author_name || '');
        info.url = d.author_url || url;
        info.bio = decode((d.html || '').replace(/<[^>]+>/g, ' ')).slice(0, 220);
        info.provider = d.provider_name || 'Facebook';
        if (d.thumbnail_url) info.avatar = d.thumbnail_url;
      }
    } catch {}
    try {
      const page = await fetch(url, { signal: AbortSignal.timeout(12000), headers, redirect: 'follow' });
      if (page.ok) {
        const html = await page.text();
        const og = (prop) => {
          const m = html.match(new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', 'i'))
            || html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']' + prop + '["\']', 'i'));
          return m ? decode(m[1]) : '';
        };
        const nameMeta = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
        if (!info.author) info.author = og('og:title') || '';
        if (!info.avatar) info.avatar = og('og:image') || '';
        if (!info.bio) info.bio = (og('og:description') || (nameMeta ? decode(nameMeta[1]) : '')).slice(0, 220);
        info.type = og('og:type') || info.type;
        // login wall
        if (/log in or sign up to view/i.test(info.bio) || /đăng nhập hoặc đăng ký/i.test(info.bio)) {
          info.bio = 'Bài/profile cần đăng nhập Facebook — bot chỉ lấy được tiêu đề công khai.';
        }
        const nums = String(info.bio).match(/([\d.,]+)\s*(followers|người theo dõi|likes|lượt thích)/i);
        if (nums) {
          const n = parseFloat(nums[1].replace(/\./g, '').replace(',', '.'));
          if (/follow|theo dõi/i.test(nums[2])) info.followers = n;
          else info.likes = n;
        }
      }
    } catch {}
    if (!info.author || /^facebook$/i.test(info.author)) {
      const slug = raw.replace(/^https?:\/\/(www\.)?facebook\.com\//i, '').split(/[/?#]/)[0] || '';
      info.author = info.author && !/^facebook$/i.test(info.author) ? info.author : (slug || 'Facebook');
      if (!info.bio || /log in or sign up/i.test(info.bio)) {
        info.bio = 'Không lấy đủ chi tiết (private / share link / cần đăng nhập). Thử username trang: /checkfb ten_trang';
      }
    }
    info.author = decode(info.author);
    info.bio = decode(info.bio);
    return info;
  }

async function lookupInstagram(input) {
    let username = String(input || '').trim();
    const m = username.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
    if (m) username = m[1];
    username = username.replace(/^@/, '').split(/[/?#\s]/)[0];
    if (!username || username.length < 2) throw new Error('Username Instagram không hợp lệ.');
    const profileUrl = 'https://www.instagram.com/' + username + '/';
    const headers = {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8'
    };
    const info = {
      username, fullName: username, avatar: '', bio: '', verified: false, private: false,
      followers: null, following: null, posts: null, profileUrl
    };
    try {
      const page = await fetch(profileUrl, { signal: AbortSignal.timeout(12000), headers, redirect: 'follow' });
      if (!page.ok) throw new Error('HTTP ' + page.status);
      const html = await page.text();
      const og = (prop) => {
        const re = new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', 'i');
        const re2 = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']' + prop + '["\']', 'i');
        const x = html.match(re) || html.match(re2);
        return x ? x[1] : '';
      };
      info.fullName = decodeHtmlEntities(og('og:title') || username);
      info.avatar = og('og:image') || '';
      info.bio = decodeHtmlEntities(og('og:description') || '').slice(0, 200);
      // "1,234 Followers, 56 Following, 78 Posts - See Instagram photos..."
      const desc = info.bio;
      const mf = desc.match(/([\d.,]+[KkMm]?)\s*Followers/i);
      const mg = desc.match(/([\d.,]+[KkMm]?)\s*Following/i);
      const mp = desc.match(/([\d.,]+[KkMm]?)\s*Posts/i);
      const parseCount = (t) => {
        if (!t) return null;
        let x = String(t).replace(/,/g, '').trim();
        const mul = /k$/i.test(x) ? 1e3 : /m$/i.test(x) ? 1e6 : 1;
        x = x.replace(/[kKmM]$/, '');
        const n = parseFloat(x);
        return Number.isFinite(n) ? Math.round(n * mul) : null;
      };
      info.followers = parseCount(mf && mf[1]);
      info.following = parseCount(mg && mg[1]);
      info.posts = parseCount(mp && mp[1]);
      if (/private/i.test(html.slice(0, 5000))) info.private = true;
    } catch (e) {
      throw new Error('Không lấy được Instagram (private / chặn bot): ' + (e.message || e));
    }
    return info;
  }

  async function lookupYouTube(input) {
    let raw = String(input || '').trim();
    let url = raw;
    if (!/^https?:\/\//i.test(raw)) {
      raw = raw.replace(/^@/, '');
      url = 'https://www.youtube.com/@' + encodeURIComponent(raw);
    }
    const headers = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8'
    };
    const info = { title: '', description: '', avatar: '', url, channelId: '', handle: '' };
    try {
      const page = await fetch(url, { signal: AbortSignal.timeout(12000), headers, redirect: 'follow' });
      if (!page.ok) throw new Error('HTTP ' + page.status);
      const html = await page.text();
      const og = (prop) => {
        const re = new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', 'i');
        const re2 = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']' + prop + '["\']', 'i');
        const x = html.match(re) || html.match(re2);
        return x ? x[1] : '';
      };
      info.title = og('og:title') || raw;
      info.description = (og('og:description') || '').slice(0, 200);
      info.avatar = og('og:image') || '';
      info.url = og('og:url') || url;
      const idm = html.match(/"channelId":"(UC[^"]+)"/);
      if (idm) info.channelId = idm[1];
      const hm = html.match(/"vanityChannelUrl":"http[^"]*\/@([^"]+)"/) || raw.match(/@([A-Za-z0-9._-]+)/);
      if (hm) info.handle = '@' + (hm[1] || '');
    } catch (e) {
      throw new Error('Không lấy được YouTube: ' + (e.message || e));
    }
    if (!info.title) throw new Error('Không tìm thấy kênh.');
    return info;
  }

  // ─── Admin commands ─────────────────────────────────────
  async function handleAdminCommand(message, text) {
    const chatId = message.chat.id;
    const from = message.from || {};
    const fromId = String(from.id || '');
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/^\//, '').split('@')[0];
    const args = parts.slice(1);
    const argText = text.replace(/^\/\S+\s*/, '').trim();

    if (cmd === 'admin' || cmd === 'panel' || cmd === 'helpadmin' || cmd === 'adminhelp') return send(chatId, '🛠 Quản lý hệ thống tại Index Admin: https://botvippro-production-0b00.up.railway.app/admin.html');

    if (cmd === 'stats') {
      const keys = options.getKeys ? options.getKeys() : [];
      const active = keys.filter(k => k.status === 'active' && !(options.isExpired?.(k))).length;
      const pending = (options.getRequests ? options.getRequests() : []).filter(r => r.status === 'pending').length;
      return send(chatId, `📊 <b>STATS</b>\n🔑 Key: ${keys.length} · ✅ Active: ${active}\n⏳ Pending: ${pending}`);
    }

    if (cmd === 'keys') {
      const keys = (options.getKeys ? options.getKeys() : []).slice().sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 12);
      if (!keys.length) return send(chatId, '📭 Chưa có key.');
      const lines = keys.map(k => {
        const d = (k.deviceHashes || []).length;
        const lim = k.deviceLimit || 3;
        const st = k.status === 'revoked' ? '🚫' : (options.isExpired?.(k) ? '⏰' : '✅');
        return `${st} <code>${k.id}</code> · ${esc(k.label)} · 📱${d}/${lim}`;
      });
      return send(chatId, `🔑 <b>KEYS</b>\n` + lines.join('\n'));
    }

    if (cmd === 'key') {
      if (!args[0]) return send(chatId, '📌 <code>/key &lt;id|mã&gt;</code>');
      const k = resolveKey(args[0]);
      if (!k) return send(chatId, '❌ Không tìm thấy.');
      const d = (k.deviceHashes || []).length;
      return send(chatId,
`🔑 <b>${esc(k.label)}</b>
🆔 <code>${k.id}</code>
📊 ${k.status} · 📱 ${d}/${k.deviceLimit || 3}
⏱ ${k.expiresAt ? new Date(k.expiresAt).toLocaleString('vi-VN') : '∞'}
📡 ${k.source || '—'} · TG ${k.telegramId || '—'}`);
    }

    if (cmd === 'createkey') {
      const hours = Math.max(0, parseInt(args[0], 10) || 24);
      const devices = Math.max(1, Math.min(10, parseInt(args[1], 10) || 3));
      const label = args.slice(2).join(' ') || `Key ${hours}h`;
      try {
        const issued = options.createKey({ label, durationHours: hours, deviceLimit: devices, source: 'telegram-admin' });
        return send(chatId,
`✅ <b>TẠO KEY</b>
🔑 <code>${issued.plainKey}</code>
🆔 <code>${issued.record.id}</code>
⏱ ${hours || '∞'}h · 📱 ${devices} TB`);
      } catch (e) {
        return send(chatId, `❌ ${e.message}`);
      }
    }

    if (cmd === 'resetdevice' || cmd === 'resetdevices') {
      if (!args[0]) return send(chatId, '📌 <code>/resetdevice &lt;id|mã&gt;</code>');
      const k = resolveKey(args[0]);
      if (!k) return send(chatId, '❌ Không tìm thấy.');
      k.deviceHashes = [];
      if (options.saveKeys) options.saveKeys();
      return send(chatId, `🔄 Đã reset 📱 key <code>${k.id}</code>\nGiới hạn: ${k.deviceLimit || 3} TB`);
    }

    if (cmd === 'revoke') {
      if (!args[0]) return send(chatId, '📌 <code>/revoke &lt;id|mã&gt;</code>');
      const k = resolveKey(args[0]);
      if (!k) return send(chatId, '❌ Không tìm thấy.');
      k.status = 'revoked';
      if (options.saveKeys) options.saveKeys();
      return send(chatId, `🚫 Đã thu hồi <code>${k.id}</code>`);
    }

    if (cmd === 'pending') {
      const list = (options.getRequests ? options.getRequests() : []).filter(r => r.status === 'pending').slice(0, 15);
      if (!list.length) return send(chatId, '✅ Không có pending.');
      const lines = list.map(r => {
        const icon = r.type === 'payment' ? '💳' : r.type === 'reset' ? '🔄' : '🎯';
        return `${icon} <code>${r.id}</code> · ${esc(r.userName)} · ${new Date(r.createdAt).toLocaleString('vi-VN')}`;
      });
      return send(chatId, `⏳ <b>PENDING</b>\n` + lines.join('\n') + `\n\n✅ /approve ID · ❌ /reject ID\n⚡ /approveall — duyệt hết`);
    }

    if (cmd === 'approve' || cmd === 'reject') {
      if (!args[0]) return send(chatId, `📌 <code>/${cmd} &lt;id&gt;</code>`);
      const approved = cmd === 'approve';
      // special handling for reset type
      const req = (options.getRequests ? options.getRequests() : []).find(r => r.id === args[0]);
      if (req && req.type === 'reset' && approved) {
        const k = resolveKey(req.resetKeyPlain || req.resetKeyHint || '');
        if (!k) {
          // try by id stored
          const byId = (options.getKeys ? options.getKeys() : []).find(x => x.id === req.resetKeyId);
          if (byId) {
            byId.deviceHashes = [];
            if (options.saveKeys) options.saveKeys();
          } else {
            return send(chatId, '❌ Không tìm thấy key để reset.');
          }
        } else {
          k.deviceHashes = [];
          if (options.saveKeys) options.saveKeys();
        }
      }
      const result = options.reviewRequest(args[0], approved, `telegram-cmd:${message.from.id}`);
      if (!result.ok) return send(chatId, `❌ ${result.error || 'Lỗi'}`);
      if (approved) await deliverReviewedKey(result, chatId);
      else await send(result.request.telegramId, `❌ Yêu cầu #${result.request.id} bị từ chối.`).catch(() => null);
      return send(chatId, approved ? `✅ #${args[0]}` : `🚫 #${args[0]}`);
    }

    if (cmd === 'approveall') {
      const list = (options.getRequests ? options.getRequests() : []).filter(r => r.status === 'pending');
      if (!list.length) return send(chatId, '✅ Không có pending.');
      let ok = 0, fail = 0;
      for (const r of list) {
        const result = options.reviewRequest(r.id, true, 'telegram-approveall:' + fromId);
        if (result.ok) {
          ok++;
          try { await deliverReviewedKey(result, chatId); } catch {}
        } else fail++;
      }
      return send(chatId, `✅ Duyệt all: ${ok} OK · ${fail} lỗi`);
    }

    if (cmd === 'settask') {
      if (!argText) return send(chatId, '📌 <code>/settask &lt;nội dung hướng dẫn&gt;</code>');
      const cfg = options.getConfig();
      cfg.groupTaskText = argText.slice(0, 2000);
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, `✅ Nhiệm vụ nhóm:\n${esc(cfg.groupTaskText)}`);
    }
    if (cmd === 'setpromo') {
      if (!argText) return send(chatId, '📌 <code>/setpromo câu quảng cáo cần copy</code>');
      const cfg = options.getConfig();
      cfg.groupPromoText = argText.slice(0, 500);
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, `✅ Câu promo:\n<code>${esc(cfg.groupPromoText)}</code>`);
    }
    if (cmd === 'settaskphotos') {
      const n = parseInt(args[0], 10);
      if (!(n >= 1 && n <= 10)) return send(chatId, '📌 <code>/settaskphotos 3</code> (1-10)');
      const cfg = options.getConfig();
      cfg.groupTaskPhotos = n;
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, `✅ Cần ${n} ảnh để nhận key free`);
    }
    if (cmd === 'settasktime') {
      const n = parseInt(args[0], 10);
      if (!(n >= 60 && n <= 3600)) return send(chatId, '📌 <code>/settasktime 300</code> (60-3600s)');
      const cfg = options.getConfig();
      cfg.groupTaskTimeoutSec = n;
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, `✅ Thời gian nhiệm vụ: ${n}s`);
    }
    if (cmd === 'setmaint') {
      const cfg = options.getConfig();
      const on = ['1','on','true','yes','bat'].includes(String(args[0]||'').toLowerCase());
      const off = ['0','off','false','no','tat'].includes(String(args[0]||'').toLowerCase());
      if (!on && !off) return send(chatId, '📌 <code>/setmaint on|off [nội dung]</code>\n<code>/lockgame id</code> <code>/unlockgame id</code>\n<code>/lockcmd getkey</code> <code>/unlockcmd getkey</code>');
      cfg.maintenance = cfg.maintenance || { enabled:false, message:'', lockedGames:[], lockedCommands:[] };
      cfg.maintenance.enabled = on;
      if (argText.replace(/^\S+\s*/, '').trim()) cfg.maintenance.message = argText.replace(/^\S+\s*/, '').trim().slice(0,500);
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, (on?'🛠 Bật bảo trì':'✅ Tắt bảo trì') + (cfg.maintenance.message ? '\n'+cfg.maintenance.message : ''));
    }
    if (cmd === 'lockgame' || cmd === 'unlockgame') {
      const id = String(args[0]||'').toLowerCase();
      if (!id) return send(chatId, '📌 <code>/lockgame sunwin</code>');
      const cfg = options.getConfig();
      cfg.maintenance = cfg.maintenance || { enabled:false, message:'', lockedGames:[], lockedCommands:[] };
      const list = new Set(cfg.maintenance.lockedGames || []);
      if (cmd === 'lockgame') list.add(id); else list.delete(id);
      cfg.maintenance.lockedGames = [...list];
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, `🎮 lockedGames: <code>${cfg.maintenance.lockedGames.join(', ')||'—'}</code>`);
    }
    if (cmd === 'lockcmd' || cmd === 'unlockcmd') {
      const id = String(args[0]||'').toLowerCase().replace(/^\//,'');
      if (!id) return send(chatId, '📌 <code>/lockcmd getkey</code>');
      const cfg = options.getConfig();
      cfg.maintenance = cfg.maintenance || { enabled:false, message:'', lockedGames:[], lockedCommands:[] };
      const list = new Set(cfg.maintenance.lockedCommands || []);
      if (cmd === 'lockcmd') list.add(id); else list.delete(id);
      cfg.maintenance.lockedCommands = [...list];
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, `⌨️ lockedCommands: <code>${cfg.maintenance.lockedCommands.join(', ')||'—'}</code>`);
    }

    if (cmd === 'setgame') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin mới dùng lệnh này.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/setgame <id_game> <url></code>\n\nVD: /setgame sunwin_tx https://sunwin.com/...\n\nXem danh sách id: /games');
      const gid = String(args[0]).toLowerCase().trim();
      const url = String(args[1]).trim();
      if (!/^https?:\/\//i.test(url)) return send(chatId, '❌ URL phải bắt đầu bằng http:// hoặc https://');
      const g = gameConfigs.find(x => x.id === gid);
      if (!g) return send(chatId, '❌ Không tìm thấy game id: <code>' + gid + '</code>\nXem danh sách: /games');
      g.url = url;
      if (FEEDS[gid]) { FEEDS[gid].url = url; FEEDS[gid].lastError = null; }
      try { saveGameConfigs(); } catch(e){}
      return send(chatId, '✅ <b>ĐÃ CẬP NHẬT LINK GAME</b>\n├─ Game: <b>' + (g.label||gid) + '</b>\n├─ ID: <code>' + gid + '</code>\n└─ URL: <code>' + url + '</code>');
    }
    if (cmd === 'games') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin mới dùng lệnh này.');
      const list = gameConfigs.map(g => '• <code>' + g.id + '</code> — ' + (g.label||'') + (g.enabled===false?' (🔒 khóa)':'')).join('\n');
      return send(chatId, '🎮 <b>DANH SÁCH GAME ID</b>\n\n' + (list||'Chưa có game nào.') + '\n\nSet link: <code>/setgame <id> <url></code>');
    }
    // ====== ADMIN: nhiều lệnh chỉnh sửa ======
    if (cmd === 'helpadmin' || cmd === 'adminhelp') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      return sendHelpAdmin(chatId, 1);
    }
    if (cmd === 'setlabel') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/setlabel <id> <tên mới></code>');
      const gid = String(args[0]).toLowerCase().trim();
      const label = args.slice(1).join(' ').slice(0, 60);
      const g = gameConfigs.find(x => x.id === gid);
      if (!g) return send(chatId, '❌ Không tìm thấy game: <code>' + gid + '</code>');
      g.label = label;
      if (FEEDS[gid]) FEEDS[gid].label = label;
      try { saveGameConfigs(); } catch(e){}
      return send(chatId, '✅ Đã đổi tên game <b>' + gid + '</b> thành: <b>' + label + '</b>');
    }
    if (cmd === 'enablegame' || cmd === 'disablegame') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const gid = String(text.trim().split(/\s+/)[1] || '').toLowerCase().trim();
      if (!gid) return send(chatId, '📌 <code>/' + cmd + ' <id_game></code>');
      const g = gameConfigs.find(x => x.id === gid);
      if (!g) return send(chatId, '❌ Không tìm thấy game: <code>' + gid + '</code>');
      g.enabled = cmd === 'enablegame';
      if (FEEDS[gid]) FEEDS[gid].enabled = g.enabled;
      try { saveGameConfigs(); } catch(e){}
      return send(chatId, (g.enabled ? '✅ Đã BẬT' : '🔒 Đã TẮT') + ' game: <b>' + (g.label||gid) + '</b>');
    }
    // ===== ALL-BOT ADMIN: thêm/xóa game + playUrl + parser + reset engine =====
    if (cmd === 'addgame') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 3) return send(chatId, '📌 <code>/addgame &lt;id&gt; &lt;parser&gt; &lt;url&gt; [nhãn]</code>\nParser: sunwin | lc79 | max789 \nVD: /addgame mytx sunwin https://api... My TX');
      const gid = String(args[0]).toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,40);
      const parser = String(args[1]).toLowerCase();
      const url = String(args[2]).trim();
      const label = args.slice(3).join(' ').slice(0,60) || gid;
      if (!gid) return send(chatId, '❌ ID không hợp lệ');
      if (!['sunwin','lc79','max789','tx'].includes(parser)) return send(chatId, '❌ Parser phải là: sunwin, lc79, max789');
      if (!/^https?:\/\//i.test(url)) return send(chatId, '❌ URL phải http/https');
      if (gameConfigs.some(x => x.id === gid)) return send(chatId, '❌ ID đã tồn tại: <code>'+gid+'</code>');
      const config = { id: gid, label, brand: gid, brandLabel: label, variant: '', url, parser, group: parser==='tx'?'tx':'tx', icon: '', enabled: true, playUrl: '', historyUrl: '', table: '' };
      gameConfigs.push(config);
      try { saveGameConfigs(); } catch(e){}
      try { FEEDS[gid] = createFeed(config); } catch(e){ console.warn('createFeed', e.message); }
      return send(chatId, '✅ <b>ĐÃ THÊM GAME</b>\n├─ ID: <code>'+gid+'</code>\n├─ Parser: '+parser+'\n├─ Nhãn: '+label+'\n└─ URL: <code>'+url+'</code>');
    }
    if (cmd === 'delgame') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const gid = String(text.trim().split(/\s+/)[1]||'').toLowerCase().trim();
      if (!gid) return send(chatId, '📌 <code>/delgame &lt;id&gt;</code>');
      const i = gameConfigs.findIndex(x => x.id === gid);
      if (i < 0) return send(chatId, '❌ Không tìm thấy: <code>'+gid+'</code>');
      const [removed] = gameConfigs.splice(i, 1);
      delete FEEDS[gid];
      try { saveGameConfigs(); saveState(); } catch(e){}
      return send(chatId, '🗑️ Đã xóa game <b>'+(removed.label||gid)+'</b> (<code>'+gid+'</code>)');
    }
    if (cmd === 'setplayurl') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/setplayurl &lt;id&gt; &lt;url&gt;</code>\nVD: /setplayurl sunwin https://sun.win/...');
      const gid = String(args[0]).toLowerCase().trim();
      const playUrl = String(args[1]).trim().slice(0,500);
      const g = gameConfigs.find(x => x.id === gid);
      if (!g) return send(chatId, '❌ Không tìm thấy game: <code>'+gid+'</code>');
      g.playUrl = playUrl;
      if (FEEDS[gid]) FEEDS[gid].playUrl = playUrl;
      // Cùng brand (vd sunwin TX + Sicbo) → dùng chung 1 link
      const brand = String(g.brand || g.id).toLowerCase().replace(/[_-]?(tx|md5|sicbo|sieu|vip).*$/i,'').replace(/\d+$/,'') || g.id;
      let synced = 0;
      (gameConfigs||[]).forEach(x => {
        if (x.id === gid) return;
        const b = String(x.brand || x.id).toLowerCase().replace(/[_-]?(tx|md5|sicbo|sieu|vip).*$/i,'').replace(/\d+$/,'') || x.id;
        if (b === brand || String(x.brand||'') === String(g.brand||'') || String(x.id).startsWith(String(g.brand||g.id).split(/[_-]/)[0])) {
          x.playUrl = playUrl;
          if (FEEDS[x.id]) FEEDS[x.id].playUrl = playUrl;
          synced++;
        }
      });
      try { saveGameConfigs(); } catch(e){}
      return send(chatId, '✅ playUrl <b>'+gid+'</b> → <code>'+playUrl+'</code>' + (synced ? ('\n🔗 Đồng bộ thêm <b>'+synced+'</b> game cùng cổng') : ''));
    }
    if (cmd === 'setparser') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/setparser &lt;id&gt; &lt;sunwin|lc79|max789&gt;</code>');
      const gid = String(args[0]).toLowerCase().trim();
      const parser = String(args[1]).toLowerCase().trim();
      if (!['sunwin','lc79','max789','tx'].includes(parser)) return send(chatId, '❌ Parser không hợp lệ');
      const g = gameConfigs.find(x => x.id === gid);
      if (!g) return send(chatId, '❌ Không tìm thấy: <code>'+gid+'</code>');
      g.parser = parser;
      if (FEEDS[gid]) FEEDS[gid].parser = parser;
      try { saveGameConfigs(); } catch(e){}
      return send(chatId, '✅ Parser <b>'+gid+'</b> → <code>'+parser+'</code>');
    }
    if (cmd === 'setgroup') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/setgroup &lt;id&gt; &lt;tx|sicbo&gt;</code>');
      const gid = String(args[0]).toLowerCase().trim();
      const group = String(args[1]).toLowerCase().trim();
      if (!['tx','sicbo'].includes(group)) return send(chatId, '❌ Group: tx | sicbo ');
      const g = gameConfigs.find(x => x.id === gid);
      if (!g) return send(chatId, '❌ Không tìm thấy: <code>'+gid+'</code>');
      g.group = group;
      if (FEEDS[gid]) FEEDS[gid].group = group;
      try { saveGameConfigs(); } catch(e){}
      return send(chatId, '✅ Group <b>'+gid+'</b> → <code>'+group+'</code>');
    }
    if (cmd === 'resetengine') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const gid = String(text.trim().split(/\s+/)[1]||'').toLowerCase().trim();
      if (!gid) return send(chatId, '📌 <code>/resetengine &lt;id_game&gt;</code>');
      const feed = FEEDS[gid];
      if (!feed) return send(chatId, '❌ Feed không tồn tại: <code>'+gid+'</code>');
      try {
        if (feed.engine) {
          feed.engine.history = [];
          feed.engine.detailedHistory = [];
          feed.engine.lastPredictions = {};
          feed.engine.consecutiveLosses = 0;
        }
        feed.history = [];
        feed.accuracyHistory = [];
        feed.lastSession = null;
        try { saveState(); } catch(e){}
        return send(chatId, '♻️ Đã reset engine + lịch sử game <b>'+gid+'</b>');
      } catch(e) {
        return send(chatId, '❌ Lỗi reset: '+e.message);
      }
    }
    if (cmd === 'settings' || cmd === 'viewsettings') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const cfg = (typeof options.getConfig === 'function' ? options.getConfig() : {}) || {};
      const mt = cfg.maintenance || {};
      const bank = (cfg.bankCode||'') + ' · ' + (cfg.bankAccount||'') + ' · ' + (cfg.bankAccountName||'');
      return send(chatId, '⚙️ <b>CẤU HÌNH HIỆN TẠI</b>\n━━━━━━━━━━━━━━━\n🎮 Game: <b>'+gameConfigs.length+'</b>\n🔑 Key: <b>'+keys.length+'</b>\n📡 Poll: <b>'+(botSettings.pollMs||'?')+'ms</b>\n📱 Max devices: <b>'+(botSettings.maxDevices||3)+'</b>\n🏦 Bank: <code>'+bank+'</code>\n🛠 Bảo trì: <b>'+(mt.enabled?'ON':'OFF')+'</b>\n🔒 Locked games: <code>'+((mt.lockedGames||[]).join(', ')||'—')+'</code>\n⌨️ Locked cmds: <code>'+((mt.lockedCommands||[]).join(', ')||'—')+'</code>\n🏷 Title: '+(cfg.siteTitle||'—')+'\n💧 WM: '+(cfg.watermarkText||'—').slice(0,40)+'\n💬 Support: '+(cfg.supportUrl||'—')+'\n\n💡 /helpadmin · /helpadmin2 · /helpadmin3');
    }
    if (cmd === 'helpadmin2') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      return sendHelpAdmin(chatId, 2);
    }
    if (cmd === 'helpadmin3') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      return sendHelpAdmin(chatId, 3);
    }
    if (cmd === 'gamedetail') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const gid = String(text.trim().split(/\s+/)[1]||'').toLowerCase().trim();
      if (!gid) return send(chatId, '📌 <code>/gamedetail &lt;id&gt;</code>');
      const g = gameConfigs.find(x => x.id === gid);
      if (!g) return send(chatId, '❌ Không tìm thấy: <code>'+gid+'</code>');
      const f = FEEDS[gid] || {};
      return send(chatId, '🎮 <b>'+esc(g.label||gid)+'</b>\n━━━━━━━━━━━━━━━\nID: <code>'+g.id+'</code>\nParser: <code>'+(g.parser||'')+'</code>\nGroup: <code>'+(g.group||'')+'</code>\nEnabled: <b>'+(g.enabled!==false?'ON':'OFF')+'</b>\nAPI: <code>'+esc(String(g.url||'').slice(0,80))+'</code>\nplayUrl: <code>'+esc(String(g.playUrl||'').slice(0,60))+'</code>\nhistoryUrl: <code>'+esc(String(g.historyUrl||'').slice(0,60))+'</code>\ntable: <code>'+(g.table||'—')+'</code>\nbrand/icon: <code>'+(g.brand||'')+'</code> / <code>'+(g.icon||'')+'</code>\nPhiên: '+(f.lastSession||'—')+' · Hist: '+(f.history?f.history.length:0)+'\nLỗi: '+(f.lastError||'—'));
    }
    if (cmd === 'sethistoryurl') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/sethistoryurl &lt;id&gt; &lt;url&gt;</code>');
      const gid = String(args[0]).toLowerCase().trim();
      const url = String(args[1]).trim();
      const g = gameConfigs.find(x => x.id === gid);
      if (!g) return send(chatId, '❌ Không tìm thấy game');
      g.historyUrl = url;
      if (FEEDS[gid]) FEEDS[gid].historyUrl = url;
      try { saveGameConfigs(); } catch(e){}
      return send(chatId, '✅ historyUrl <b>'+gid+'</b> đã cập nhật');
    }
    if (cmd === 'settable') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/settable &lt;id&gt; &lt;tên bàn&gt;</code>');
      const gid = String(args[0]).toLowerCase().trim();
      const table = args.slice(1).join(' ').slice(0,80);
      const g = gameConfigs.find(x => x.id === gid);
      if (!g) return send(chatId, '❌ Không tìm thấy game');
      g.table = table;
      if (FEEDS[gid]) FEEDS[gid].table = table;
      try { saveGameConfigs(); } catch(e){}
      return send(chatId, '✅ table <b>'+gid+'</b> → <code>'+esc(table)+'</code>');
    }
    if (cmd === 'setbrand') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/setbrand &lt;id&gt; &lt;brand&gt;</code>');
      const gid = String(args[0]).toLowerCase().trim();
      const brand = String(args[1]).trim().slice(0,40);
      const g = gameConfigs.find(x => x.id === gid);
      if (!g) return send(chatId, '❌ Không tìm thấy game');
      g.brand = brand; g.brandLabel = g.brandLabel || brand;
      try { saveGameConfigs(); } catch(e){}
      return send(chatId, '✅ brand <b>'+gid+'</b> → <code>'+esc(brand)+'</code>');
    }
    if (cmd === 'seticon' || cmd === 'setgameicon' || cmd === 'setimg') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <b>Đổi ảnh game</b>\n<code>/seticon id url_ảnh</code>\nVD: /seticon sunwin https://i.imgur.com/xxx.png\nHoặc key có sẵn: sunwin, hitclub, max789…\nÁp dụng cả brand: <code>/seticon sunwin URL --brand</code>');
      const gid = String(args[0]).toLowerCase().trim();
      const applyBrand = args.includes('--brand') || args.includes('-b');
      const icon = String(args.filter(a => a !== '--brand' && a !== '-b')[1] || '').trim().slice(0, 500);
      if (!icon) return send(chatId, '❌ Thiếu URL hoặc key icon');
      const g = gameConfigs.find(x => x.id === gid);
      if (!g) return send(chatId, '❌ Không tìm thấy game. /games');
      g.icon = icon;
      let n = 1;
      if (applyBrand) {
        const brand = g.brand || g.id;
        gameConfigs.forEach(x => {
          if (x.id === gid) return;
          if (String(x.brand||x.id) === String(brand)) { x.icon = icon; n++; }
        });
      }
      try { saveGameConfigs(); } catch(e){}
      // cập nhật FEEDS label icon nếu có
      try {
        gameConfigs.forEach(x => {
          if (FEEDS[x.id]) FEEDS[x.id].icon = x.icon || '';
        });
      } catch(e){}
      return send(chatId, '✅ Ảnh game <b>'+gid+'</b>'+(applyBrand?' (+brand '+n+' game)':'')+'\n<code>'+esc(icon.slice(0,120))+'</code>\n💡 User F5 index để thấy ảnh mới');
    }
    if (cmd === 'clonegame') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/clonegame &lt;fromId&gt; &lt;toId&gt; [nhãn]</code>');
      const fromId = String(args[0]).toLowerCase().trim();
      const toId = String(args[1]).toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,40);
      const label = args.slice(2).join(' ').slice(0,60) || toId;
      const src = gameConfigs.find(x => x.id === fromId);
      if (!src) return send(chatId, '❌ Nguồn không tồn tại');
      if (gameConfigs.some(x => x.id === toId)) return send(chatId, '❌ toId đã tồn tại');
      const config = Object.assign({}, src, { id: toId, label: label, brand: toId, brandLabel: label });
      gameConfigs.push(config);
      try { saveGameConfigs(); FEEDS[toId] = createFeed(config); } catch(e){}
      return send(chatId, '✅ Clone <b>'+fromId+'</b> → <code>'+toId+'</code> ('+esc(label)+')');
    }
    if (cmd === 'testgame') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const gid = String(text.trim().split(/\s+/)[1]||'').toLowerCase().trim();
      if (!gid || !FEEDS[gid]) return send(chatId, '📌 <code>/testgame &lt;id&gt;</code> — game phải tồn tại\n💡 /games để xem id');
      try {
        await pollFeed(gid);
        const f = FEEDS[gid];
        const last = f.lastSession;
        const openS = f.openSession || (last != null && /^\d+$/.test(String(last)) ? String(Number(last)+1) : '—');
        const top = (f.rawTop5 && f.rawTop5.length ? f.rawTop5.map(x=>'#'+x).join(' · ') : (f.history||[]).slice(0, 5).map(h => '#'+h.session+':'+(h.char||'?')).join(' · ')) || '—';
        const live = f.lastLive ? (f.lastLive.char||'?')+' sum='+(f.lastLive.sum??'—') : '—';
        // các id cùng brand
        const g0 = gameConfigs.find(x => x.id === gid) || {};
        const brand = g0.brand || gid;
        const siblings = gameConfigs.filter(x => (x.brand||x.id) === brand || x.id === gid).map(x => {
          const ff = FEEDS[x.id];
          return '• <code>'+x.id+'</code> phiên '+(ff&&ff.lastSession!=null?ff.lastSession:'—');
        }).join('\n');
        return send(chatId, '🧪 <b>TEST '+gid+'</b>\n━━━━━━━━━━━━━━━\n📥 <b>API last</b>: <code>'+(last??'—')+'</code>\n🎯 <b>Robot next</b>: <code>'+openS+'</code>\n🎲 Live row: '+live+'\n📚 Hist: '+(f.history?f.history.length:0)+'\n🔝 Top: '+top+'\n⏱ Poll: '+(f.lastPolledAt?new Date(f.lastPolledAt).toLocaleTimeString('vi-VN'):'—')+'\nLỗi: '+(f.lastError||'Không')+'\n\n🏷 Cùng brand:\n'+(siblings||'—')+'\n\n⚠️ Robot trong index = <b>Robot next</b>.\nNếu bàn web lớn hơn nhiều → URL API đang trả data cũ, đổi bằng /setgame');
      } catch(e) {
        return send(chatId, '❌ Test lỗi: '+e.message);
      }
    }
    if (cmd === 'gameerror') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const lines = gameConfigs.map(g => {
        const f = FEEDS[g.id];
        if (!f || !f.lastError) return null;
        return '• <code>'+g.id+'</code>: '+esc(String(f.lastError).slice(0,80));
      }).filter(Boolean);
      return send(chatId, lines.length ? ('⚠️ <b>GAME LỖI</b>\n'+lines.join('\n')) : '✅ Không game nào đang báo lỗi API');
    }
    if (cmd === 'enableall' || cmd === 'disableall') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const on = cmd === 'enableall';
      gameConfigs.forEach(g => { g.enabled = on; if (FEEDS[g.id]) FEEDS[g.id].enabled = on; });
      try { saveGameConfigs(); } catch(e){}
      return send(chatId, (on?'✅ Đã BẬT':'🔒 Đã TẮT')+' <b>tất cả</b> game ('+gameConfigs.length+')');
    }
    if (cmd === 'reloadgames') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      try {
        const loaded = loadJSON(GAMES_FILE, null);
        if (Array.isArray(loaded)) { gameConfigs = loaded; initializeFeedConfigs(); }
        return send(chatId, '♻️ Đã reload '+gameConfigs.length+' game từ file');
      } catch(e) { return send(chatId, '❌ '+e.message); }
    }
    if (cmd === 'givekey') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/givekey &lt;telegramId&gt; &lt;giờ&gt; [tb]</code>\nVD: /givekey 123456789 24 3');
      const tgid = String(args[0]).replace(/\D/g,'');
      const hours = Math.max(0, parseInt(args[1],10)||24);
      const devices = Math.max(1, Math.min(10, parseInt(args[2],10)||3));
      if (!tgid) return send(chatId, '❌ telegramId không hợp lệ');
      try {
        const issued = options.createKey({ label: 'Gift '+hours+'h', durationHours: hours, deviceLimit: devices, source: 'telegram-gift', telegramId: tgid });
        await send(tgid, '🎁 <b>ADMIN TẶNG KEY</b>\n🔑 <code>'+issued.plainKey+'</code>\n⏱ '+hours+'h · 📱 '+devices+' TB\n\nMở Mini App và đăng nhập bằng mã này.');
        return send(chatId, '✅ Đã tạo + gửi key cho <code>'+tgid+'</code>\n🔑 <code>'+issued.plainKey+'</code>');
      } catch(e) { return send(chatId, '❌ '+e.message); }
    }
    if (cmd === 'findkey') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const q = String(text.trim().split(/\s+/)[1]||'').trim();
      if (!q) return send(chatId, '📌 <code>/findkey &lt;tgid|mã|id&gt;</code>');
      const list = (options.getKeys?options.getKeys():keys).filter(k =>
        String(k.telegramId||'')===q || String(k.id||'').includes(q) || String(k.label||'').toLowerCase().includes(q.toLowerCase()) || String(k.plainKey||'')===q
      ).slice(0,15);
      if (!list.length) {
        const byHash = options.findKey ? options.findKey(q) : findKey(q);
        if (byHash) list.push(byHash);
      }
      if (!list.length) return send(chatId, '❌ Không tìm thấy');
      const lines = list.map(k => {
        const st = k.status==='revoked'?'🚫':(options.isExpired&&options.isExpired(k)?'⏰':'✅');
        return st+' <code>'+(k.id||'')+'</code> · TG '+(k.telegramId||'—')+' · '+(k.label||'')+' · 📱'+((k.deviceHashes||[]).length)+'/'+(k.deviceLimit||3);
      });
      return send(chatId, '🔍 <b>KẾT QUẢ</b>\n'+lines.join('\n'));
    }
    if (cmd === 'setkeylimit') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/setkeylimit &lt;key|id&gt; &lt;số tb&gt;</code>');
      const k = (options.findKey&&options.findKey(args[0])) || (options.getKeys?options.getKeys():keys).find(x=>x.id===args[0]);
      if (!k) return send(chatId, '❌ Không tìm thấy key');
      k.deviceLimit = Math.max(1, Math.min(20, parseInt(args[1],10)||3));
      try { if (options.saveKeys) options.saveKeys(); else saveKeys(); } catch(e){}
      return send(chatId, '✅ deviceLimit key <code>'+k.id+'</code> → <b>'+k.deviceLimit+'</b>');
    }
    if (cmd === 'setkeylabel') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/setkeylabel &lt;key|id&gt; &lt;nhãn&gt;</code>');
      const k = (options.findKey&&options.findKey(args[0])) || (options.getKeys?options.getKeys():keys).find(x=>x.id===args[0]);
      if (!k) return send(chatId, '❌ Không tìm thấy key');
      k.label = args.slice(1).join(' ').slice(0,80);
      try { if (options.saveKeys) options.saveKeys(); else saveKeys(); } catch(e){}
      return send(chatId, '✅ label → <b>'+esc(k.label)+'</b>');
    }
    if (cmd === 'activekeys') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const list = (options.getKeys?options.getKeys():keys).filter(k => k.status!=='revoked' && !(options.isExpired&&options.isExpired(k))).slice(0,20);
      if (!list.length) return send(chatId, '📭 Không có key active');
      return send(chatId, '✅ <b>ACTIVE KEYS</b> ('+list.length+')\n'+list.map(k=>'• <code>'+k.id+'</code> · '+(k.label||'')+' · TG '+(k.telegramId||'—')).join('\n'));
    }
    if (cmd === 'expiredkeys') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const list = (options.getKeys?options.getKeys():keys).filter(k => options.isExpired&&options.isExpired(k)).slice(0,20);
      if (!list.length) return send(chatId, '✅ Không có key hết hạn');
      return send(chatId, '⏰ <b>EXPIRED</b> ('+list.length+')\n'+list.map(k=>'• <code>'+k.id+'</code> · '+(k.label||'')).join('\n'));
    }
    if (cmd === 'setwatermark') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      if (!argText) return send(chatId, '📌 <code>/setwatermark &lt;nội dung&gt;</code>');
      const cfg = options.getConfig();
      cfg.watermarkText = argText.slice(0,300);
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, '✅ Watermark:\n<code>'+esc(cfg.watermarkText)+'</code>');
    }
    if (cmd === 'setsitetitle') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      if (!argText) return send(chatId, '📌 <code>/setsitetitle &lt;tên&gt;</code>');
      const cfg = options.getConfig();
      cfg.siteTitle = argText.slice(0,80);
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, '✅ Site title: <b>'+esc(cfg.siteTitle)+'</b>');
    }
    if (cmd === 'setsupport') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      if (!argText) return send(chatId, '📌 <code>/setsupport https://t.me/xxx</code> hoặc <code>@user</code>');
      const cfg = options.getConfig();
      let u = argText.trim();
      if (u.startsWith('@')) u = 'https://t.me/'+u.slice(1);
      cfg.supportUrl = u.slice(0,200);
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, '✅ Support: <code>'+esc(cfg.supportUrl)+'</code>');
    }
    if (cmd === 'setannounce') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      if (!argText) return send(chatId, '📌 <code>/setannounce &lt;nội dung thông báo&gt;</code>');
      const cfg = options.getConfig();
      cfg.announceText = argText.slice(0,1000);
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, '✅ Đã lưu thông báo (user xem /thongbao):\n'+esc(cfg.announceText).slice(0,200));
    }
    if (cmd === 'logs') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      try {
        const lines = fs.readFileSync(LOG_FILE,'utf8').split('\n').filter(Boolean).slice(-25);
        return send(chatId, '📜 <b>LOGS</b> (25 dòng cuối)\n<code>'+esc(lines.join('\n')).slice(0,3500)+'</code>');
      } catch(e) { return send(chatId, '❌ Không đọc được log'); }
    }
    if (cmd === 'clearlogs') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      try { fs.writeFileSync(LOG_FILE, ''); return send(chatId, '🗑️ Đã xóa log file'); }
      catch(e) { return send(chatId, '❌ '+e.message); }
    }
    if (cmd === 'ping') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      return send(chatId, '🏓 Pong · ' + new Date().toLocaleString('vi-VN') + '\nGame: '+Object.keys(FEEDS).length+' · Key: '+keys.length);
    }
    if (cmd === 'whoami') {
      return send(chatId, '👤 ID: <code>'+fromId+'</code>\nTên: '+esc(name)+'\nAdmin: '+(isAdmin(fromId)?'✅':'❌'));
    }
    if (cmd === 'users') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const ids = new Set();
      (botRequests||[]).forEach(r => { if (r.telegramId) ids.add(String(r.telegramId)); });
      (keys||[]).forEach(k => { if (k.telegramId) ids.add(String(k.telegramId)); });
      const pending = (botRequests||[]).filter(r => r.status==='pending').length;
      return send(chatId, '👥 <b>USERS</b>\nUnique TG: <b>'+ids.size+'</b>\nKey records: <b>'+keys.length+'</b>\nPending requests: <b>'+pending+'</b>');
    }
    if (cmd === 'userinfo' || cmd === 'user' || cmd === 'profile') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const q = String(args[0] || '').replace(/^@/, '').trim();
      if (!q) return send(chatId, '📌 <code>/userinfo &lt;telegramId|@username&gt;</code>');
      let p = null;
      if (userProfiles[q]) p = userProfiles[q];
      else {
        const hit = Object.values(userProfiles).find(u => String(u.username||'').toLowerCase() === q.toLowerCase() || String(u.telegramId) === q);
        p = hit || null;
      }
      if (!p && /^\d+$/.test(q)) {
        p = { telegramId: q, name: '—', username: '' };
      }
      if (!p) return send(chatId, '❌ Chưa có hồ sơ. User cần /start hoặc mở Mini App trước.');
      const uk = (keys||[]).filter(k => String(k.telegramId) === String(p.telegramId));
      const reqs = (botRequests||[]).filter(r => String(r.telegramId) === String(p.telegramId)).slice(0, 5);
      let extra = '\n🔑 Keys gắn: <b>' + uk.length + '</b>';
      if (uk.length) {
        extra += '\n' + uk.slice(-3).map(k => '· ' + (k.label||'') + ' · ' + (k.status||'') + ' · 📱' + ((k.deviceHashes||[]).length) + '/' + (k.deviceLimit||3)).join('\n');
      }
      extra += '\n📩 Requests: ' + reqs.length;
      return send(chatId, formatUserProfile(p, extra));
    }
    if (cmd === 'topusers') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const list = Object.values(userProfiles||{}).sort((a,b)=>(b.lastSeen||0)-(a.lastSeen||0)).slice(0,15);
      if (!list.length) return send(chatId, '📭 Chưa có user profile');
      return send(chatId, '👥 <b>TOP USER GẦN ĐÂY</b>\n' + list.map(u => '· <code>'+u.telegramId+'</code> '+(u.username?'@'+u.username:u.name||'')+' · IP '+(u.lastIp||'—')).join('\n'));
    }

    if (cmd === 'orders') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      try {
        const list = (typeof orders!=='undefined' && Array.isArray(orders) ? orders : []).slice().reverse().slice(0,12);
        if (!list.length) return send(chatId, '📭 Chưa có đơn (orders.js runtime)');
        return send(chatId, '💳 <b>ORDERS</b>\n'+list.map(o=>'• <code>'+o.id+'</code> '+(o.status||'')+' · '+(o.planLabel||o.planId)+' · '+o.price+'đ · TG '+(o.telegramId||'—')).join('\n'));
      } catch(e) { return send(chatId, '📭 Orders chưa sẵn sàng trong bot scope'); }
    }
    if (cmd === 'rejectall') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const pending = (options.getRequests?options.getRequests():[]).filter(r => r.status==='pending');
      let n = 0;
      for (const r of pending) {
        try { options.reviewRequest(r.id, false, 'telegram-rejectall:'+fromId); n++; } catch(e){}
      }
      return send(chatId, '🗑️ Đã từ chối <b>'+n+'</b> yêu cầu pending');
    }
    if (cmd === 'setplanprice' || cmd === 'setplanduration' || cmd === 'setplandevices' || cmd === 'toggleplan') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (!args[0]) return send(chatId, '📌 Cần id gói');
      const cfg = options.getConfig();
      cfg.plans = cfg.plans || [];
      const p = cfg.plans.find(x => x.id === String(args[0]).toLowerCase());
      if (!p) return send(chatId, '❌ Không có gói: <code>'+args[0]+'</code> · /plans');
      if (cmd === 'toggleplan') { p.active = p.active === false ? true : false; }
      else if (cmd === 'setplanprice') { p.price = Math.max(0, Number(args[1])||0); }
      else if (cmd === 'setplanduration') { p.durationHours = Math.max(1, Number(args[1])||24); }
      else if (cmd === 'setplandevices') { p.deviceLimit = Math.max(1, Math.min(20, Number(args[1])||3)); }
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, '✅ Gói <b>'+p.id+'</b>\n'+p.label+' · '+p.price+'đ · '+p.durationHours+'h · TB '+(p.deviceLimit||3)+' · '+(p.active===false?'OFF':'ON'));
    }
    if (cmd === 'setpoll') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const ms = Number(text.trim().split(/\s+/)[1] || 0);
      if (!ms || ms < 1000) return send(chatId, '📌 <code>/setpoll <giây></code> — tối thiểu 1000ms (1 giây)\nVD: /setpoll 8000');
      botSettings.pollMs = ms;
      try { saveJSON(SETTINGS_FILE, botSettings); } catch(e){}
      return send(chatId, '✅ Đã set chu kỳ poll: <b>' + ms + 'ms</b> (' + (ms/1000).toFixed(1) + 's)');
    }
    if (cmd === 'setmaxdevices') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const n = Number(text.trim().split(/\s+/)[1] || 0);
      if (!n || n < 1) return send(chatId, '📌 <code>/setmaxdevices <số></code>\nVD: /setmaxdevices 3');
      botSettings.maxDevices = n;
      try { saveJSON(SETTINGS_FILE, botSettings); } catch(e){}
      return send(chatId, '✅ Đã set tối đa <b>' + n + '</b> thiết bị/key');
    }
    if (cmd === 'delkey') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const plain = String(text.trim().split(/\s+/)[1] || '').trim();
      if (!plain) return send(chatId, '📌 <code>/delkey <mã key></code>');
      const k = findKey(plain);
      if (!k) return send(chatId, '❌ Key không tồn tại.');
      const i = keys.indexOf(k);
      if (i >= 0) keys.splice(i, 1);
      try { saveJSON(KEYS_FILE, keys); } catch(e){}
      return send(chatId, '🗑️ Đã xóa key: <code>' + plain + '</code>');
    }
    if (cmd === 'extendkey') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const args = text.trim().split(/\s+/).slice(1);
      if (args.length < 2) return send(chatId, '📌 <code>/extendkey <key> <số giờ></code>\nVD: /extendkey KYT-XXX 720');
      const plain = String(args[0]).trim();
      const hours = Number(args[1]) || 0;
      const k = findKey(plain);
      if (!k) return send(chatId, '❌ Key không tồn tại.');
      const now = Date.now();
      const base = Math.max(now, k.expiresAt || now);
      k.expiresAt = base + hours * 3600 * 1000;
      try { saveJSON(KEYS_FILE, keys); } catch(e){}
      return send(chatId, '⏰ Đã gia hạn key <code>' + plain + '</code> thêm <b>' + hours + ' giờ</b>\nHạn mới: ' + new Date(k.expiresAt).toLocaleString('vi-VN'));
    }
    if (cmd === 'clearkeys') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const now = Date.now();
      const before = keys.length;
      for (let i = keys.length - 1; i >= 0; i--) {
        if (keys[i].expiresAt && keys[i].expiresAt < now) keys.splice(i, 1);
      }
      try { saveJSON(KEYS_FILE, keys); } catch(e){}
      return send(chatId, '🧹 Đã xóa <b>' + (before - keys.length) + '</b> key hết hạn.\nCòn lại: <b>' + keys.length + '</b> key.');
    }
    if (cmd === 'listkeys') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const now = Date.now();
      const active = keys.filter(k => !k.expiresAt || k.expiresAt > now);
      const expired = keys.length - active.length;
      let msg = '🔑 <b>THỐNG KÊ KEY</b>\n━━━━━━━━━━━━━━━\n';
      msg += '• Tổng: <b>' + keys.length + '</b>\n• Còn hạn: <b>' + active.length + '</b>\n• Hết hạn: <b>' + expired + '</b>\n\n';
      msg += active.slice(0, 15).map(k => '• <code>' + (k.plainKey||'?') + '</code> — ' + (k.label||'') + ' — ' + (k.expiresAt ? new Date(k.expiresAt).toLocaleDateString('vi-VN') : 'Vĩnh viễn')).join('\n');
      if (active.length > 15) msg += '\n... và ' + (active.length-15) + ' key nữa';
      return send(chatId, msg);
    }
    if (cmd === 'broadcast') {
      if (!isAdmin(fromId)) return send(chatId, '⛔ Chỉ admin.');
      const msg = text.trim().split(/\s+/).slice(1).join(' ');
      if (!msg) return send(chatId, '📌 <code>/broadcast <nội dung></code>');
      const ids = new Set();
      (botRequests||[]).forEach(r => { if (r.telegramId) ids.add(String(r.telegramId)); });
      let sent = 0;
      ids.forEach(id => { try { send(Number(id), '📢 <b>THÔNG BÁO</b>\n━━━━━━━━━━━━━━━\n\n' + msg); sent++; } catch(e){} });
      return send(chatId, '📢 Đã gửi thông báo cho <b>' + sent + '</b> user.');
    }
    if (cmd === 'setbank') {
      if (args.length < 3) return send(chatId, '📌 <code>/setbank &lt;NH&gt; &lt;STK&gt; &lt;chủ&gt;</code>');
      const cfg = options.getConfig();
      cfg.bankCode = args[0];
      cfg.bankAccount = args[1];
      cfg.bankAccountName = args.slice(2).join(' ');
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, `✅ 🏦 ${esc(cfg.bankCode)} · <code>${esc(cfg.bankAccount)}</code>\n👤 ${esc(cfg.bankAccountName)}`);
    }

    if (cmd === 'settg') {
      const u = (args[0] || '').replace(/^@/, '');
      const cfg = options.getConfig();
      cfg.telegramUsername = u;
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, `✅ Bot: @${esc(u) || '—'}`);
    }

    if (cmd === 'addplan') {
      if (args.length < 4) return send(chatId, '📌 <code>/addplan id nhãn giá giờ</code>');
      const id = args[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
      const price = parseInt(args[args.length - 2], 10);
      const hours = parseInt(args[args.length - 1], 10);
      const label = args.slice(1, -2).join(' ').replace(/^["']|["']$/g, '');
      if (!id || !label || !price || !hours) return send(chatId, '❌ Thiếu thông tin.');
      const cfg = options.getConfig();
      cfg.plans = cfg.plans || [];
      if (cfg.plans.some(p => p.id === id)) return send(chatId, '❌ ID trùng.');
      cfg.plans.push({ id, label, price, durationHours: hours, active: true });
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, `✅ 💎 ${esc(label)} · ${fmt(price)}đ · ${hours}h`);
    }

    if (cmd === 'delplan') {
      if (!args[0]) return send(chatId, '📌 <code>/delplan &lt;id&gt;</code>');
      const cfg = options.getConfig();
      const before = (cfg.plans || []).length;
      cfg.plans = (cfg.plans || []).filter(p => p.id !== args[0].toLowerCase());
      if (options.saveConfig) options.saveConfig(cfg);
      return send(chatId, cfg.plans.length < before ? `✅ Xóa ${args[0]}` : '❌ Không thấy.');
    }

    if (cmd === 'plans') {
      const list = plans();
      if (!list.length) return send(chatId, '📭 Chưa có gói.');
      return send(chatId, `💎 <b>GÓI</b>\n` + list.map(p => `• <code>${p.id}</code> ${esc(p.label)} · ${fmt(p.price)}đ · ${p.durationHours}h`).join('\n'));
    }

    return send(chatId, '❓ Gõ /helpadmin để xem lệnh admin');
  }

  // ─── Message router ─────────────────────────────────────

  async function showBuyMenu(chatId) {
    const available = plans();
    if (!available.length) return send(chatId, '📭 Hiện chưa có gói key đang bán. Vui lòng quay lại sau hoặc liên hệ @SunNetWin.');
    const rows = available.map(p => {
      const hours = Number(p.durationHours) || 0;
      const duration = hours >= 24 ? `${Math.round(hours / 24)} ngày` : `${hours} giờ`;
      return `╭ <b>${esc(p.label)}</b>${p.hot ? ' · 🔥 PHỔ BIẾN' : ''}\n├ Giá: <b>${fmt(p.price)}đ</b>\n├ Thời hạn: ${duration} · Thiết bị: ${Number(p.deviceLimit) || 1}\n╰ Mua bằng lệnh: <code>/pay ${esc(p.id)}</code>`;
    });
    return send(chatId, `💳 <b>BẢNG GIÁ KEY TOOLTUNGTUNG</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${rows.join('\n\n')}\n\nSau khi tạo thanh toán, làm theo hướng dẫn và gửi bill trong chat này.\n💬 Hỗ trợ: @SunNetWin`);
  }

  async function startPayment(chatId, fromId, planId) {
    const plan = plans().find(p => p.id === String(planId || '').toLowerCase());
    if (!plan) return send(chatId, '❌ Gói không tồn tại. Gõ /muakeytx để chọn lại.');
    const config = options.getConfig();
    if (!config.bankCode || !config.bankAccount || !config.bankAccountName) {
      logLine('[shop] payment unavailable: bank account settings incomplete');
      return send(chatId, 'Hiện chưa thể tạo mã thanh toán. Vui lòng thử lại sau hoặc liên hệ @SunNetWin.');
    }
    const orderId = genOrderId();
    const timeoutSec = Math.min(900, Math.max(60, Number(config.orderTimeoutSec || 300)));
    const order = {
      id: orderId, planId: plan.id, planLabel: plan.label, price: Number(plan.price),
      durationHours: Number(plan.durationHours), deviceLimit: 1,
      telegramId: String(fromId), status: 'pending', createdAt: Date.now(),
      expiresAt: Date.now() + timeoutSec * 1000, content: orderId, chatId: String(chatId)
    };
    const paymentSessions = options.getSessions();
    paymentSessions[String(fromId)] = { type: 'payment', planId: plan.id, orderId, startedAt: Date.now() };
    options.saveSessions(paymentSessions);
    try {
      if (typeof orders !== 'undefined') {
        orders.push(order);
        if (orders.length > 500) orders.splice(0, orders.length - 500);
        if (typeof saveOrders === 'function') saveOrders();
      }
    } catch (e) {}
    const qr = buildVietQr(plan.price, orderId) || (`https://img.vietqr.io/image/${encodeURIComponent(config.bankCode)}-${encodeURIComponent(config.bankAccount)}-compact2.jpg?amount=${encodeURIComponent(String(plan.price))}&addInfo=${encodeURIComponent(orderId)}&accountName=${encodeURIComponent(config.bankAccountName)}`);
    const days = plan.durationHours >= 24 ? `${Math.round(plan.durationHours / 24)} ngày` : `${plan.durationHours}h`;
    const sent = await sendPhoto(chatId, qr, {
      caption: '<b>TOOLTUNGTUNG · THÔNG TIN THANH TOÁN</b>\n'
        + '━━━━━━━━━━━━━━━━━━━━\n'
        + 'Gói: <b>' + esc(plan.label) + '</b>\n'
        + 'Thời hạn: <b>' + days + '</b>\n'
        + 'Số tiền: <b>' + fmt(plan.price) + 'đ</b>\n\n'
        + '<b>NGÂN HÀNG</b> · ' + esc(config.bankCode) + '\n'
        + '<b>SỐ TÀI KHOẢN</b>\n<code>' + esc(config.bankAccount) + '</code>\n'
        + '<b>CHỦ TÀI KHOẢN</b>\n' + esc(config.bankAccountName) + '\n\n'
        + '<b>NỘI DUNG CHUYỂN KHOẢN</b>\n<code>' + orderId + '</code>\n\n'
        + 'Vui lòng chuyển đúng số tiền và giữ nguyên nội dung trên.\n'
        + 'Mã QR có hiệu lực <b>' + Math.round(timeoutSec / 60) + ' phút</b>. Sau khi hệ thống xác nhận, key sẽ được gửi qua bot.\n'
        + '━━━━━━━━━━━━━━━━━━━━\n'
        + 'Hỗ trợ: @SunNetWin'
    });
    const msgId = sent && (sent.result && sent.result.message_id);
    if (msgId && typeof orders !== 'undefined') {
      const o = orders.find(x => x.id === orderId);
      if (o) { o.tgMessageId = msgId; o.chatId = String(chatId); if (typeof saveOrders === 'function') saveOrders(); }
    }
    // auto expire
    setTimeout(async () => {
      try {
        const o = (typeof orders !== 'undefined' ? orders : []).find(x => x.id === orderId);
        if (!o || o.status !== 'pending') return;
        o.status = 'expired';
        if (typeof saveOrders === 'function') saveOrders();
        const expireText = (config.botPayExpireText || 'Số tiền key thời gian tạo đã hết hạn. Vui lòng tạo mới nếu mua hàng.');
        if (msgId) {
          try { await tg('deleteMessage', { chat_id: chatId, message_id: msgId }); } catch (e) {}
        }
        await send(chatId, '⏰ <b>ĐƠN HẾT HẠN</b>\n' + esc(expireText) + '\n\nGói: <b>' + esc(plan.label) + '</b> · ' + fmt(plan.price) + 'đ\nMã: <code>' + orderId + '</code>');
      } catch (e) {}
    }, timeoutSec * 1000);
  }

  async function handleCallback(cq) {
    if (!cq) return;
    const data = String(cq.data || '');
    const chatId = cq.message?.chat?.id;
    const fromId = String(cq.from?.id || '');
    try { await tg('answerCallbackQuery', { callback_query_id: cq.id }); } catch {}
    if (!chatId) return;
    if (data.startsWith('pay:')) {
      const planId = data.slice(4);
      return startPayment(chatId, fromId, planId);
    }
    if (data === 'buy_menu') return showBuyMenu(chatId);
    if (data === 'cmd:getkey') return startGroupKeyTask(chatId, fromId, cq.from);
    if (data === 'cmd:getkeyv2') return startGetkeyV2(chatId, fromId, cq.from);
    if (data === 'cmd:feedback') {
      const sessions = options.getSessions(); sessions[fromId] = { type: 'feedback', startedAt: Date.now() }; options.saveSessions(sessions);
      return send(chatId, '🏆 <b>CHIA SẺ TRẢI NGHIỆM</b>\n<b>Bước 1/2:</b> Gửi ảnh chụp kết quả hoặc trải nghiệm của bạn.\n<b>Bước 2/2:</b> Sau khi bot nhận ảnh, gửi một tin nhắn ghi chú ngắn (ví dụ: bạn thích tính năng nào hoặc muốn chia sẻ kết quả gì).\n\nBot tự ghi nhận tên, username và Telegram ID để Admin xác minh. Bài chỉ đăng lên kênh sau khi Admin duyệt. Gõ /cancel để hủy.');
    }
    if (data === 'cmd:mykey') {
      // fall through to mykey logic via fake message if needed
      return send(chatId, 'Gõ /mykey để xem key của bạn.');
    }
    if (data === 'noop') return; // copy hint button
    if (data === 'cmd:resetkey') {
      const sessions = options.getSessions();
      sessions[fromId] = { type: 'await_reset_key', startedAt: Date.now() };
      options.saveSessions(sessions);
      return send(chatId, 'ℹ️ Chức năng đổi/reset key đã được gỡ. Liên hệ @SunNetWin nếu cần hỗ trợ.');
    }
    if (data === 'cmd:status') {
      const pending = (options.getRequests ? options.getRequests() : []).filter(r => String(r.telegramId) === fromId && r.status === 'pending');
      if (!pending.length) return send(chatId, '✅ Không có yêu cầu chờ.');
      return send(chatId, '⏳ <b>' + pending.length + ' yêu cầu</b>\n' + pending.map(r => '• #' + r.id + ' ' + (r.type || '')).join('\n'));
    }
    if (data === 'cmd:start') return showStart(chatId, displayName(cq.from), cq.from);
    if (data === 'cmd:menu') return showUserMenu(chatId);
    // Admin controls are handled only in the web admin index.
    if (data.startsWith('adm:') || data.startsWith('ap:') || data.startsWith('rj:')) {
      try { await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Quản lý tại Index Admin', show_alert: true }); } catch {}
      return;
    }
    // ===== ADMIN INLINE PANEL (nút gọn) =====
    if (data.startsWith('adm:') && isAdmin(fromId)) {
      try { await tg('answerCallbackQuery', { callback_query_id: cq.id }); } catch (e) {}
      const act = data.slice(4);
      if (['home','req','keys','games','plans','sys','site','cmds'].includes(act)) return showAdminHelp(chatId, act);
      if (act === 'help') return showAdminHelp(chatId, 'home');
      if (act === 'pending') {
        const pending = (options.getRequests ? options.getRequests() : []).filter(r => r.status === 'pending').slice(0, 15);
        if (!pending.length) return send(chatId, '✅ Không có yêu cầu chờ duyệt.');
        for (const r of pending) {
          const line = `📩 <b>#${r.id}</b> · ${r.type || '?'} · TG <code>${r.telegramId || ''}</code> · ${esc(r.userName || r.username || '')}`;
          await send(chatId, line, { reply_markup: { inline_keyboard: [[
            { text: '✅ Duyệt', callback_data: 'ap:' + r.id },
            { text: '❌ Từ chối', callback_data: 'rj:' + r.id }
          ]] } });
        }
        return;
      }
      if (act === 'approveall') {
        const list = (options.getRequests ? options.getRequests() : []).filter(r => r.status === 'pending');
        let n = 0;
        for (const r of list) {
          try {
            const result = options.reviewRequest(r.id, true, 'telegram-btn-approveall:' + fromId);
            if (result && result.ok) { n++; try { await deliverReviewedKey(result, chatId); } catch (e) {} }
          } catch (e) {}
        }
        return send(chatId, '✅ Duyệt nhanh <b>' + n + '</b> yêu cầu.');
      }
      if (act === 'rejectall') {
        const list = (options.getRequests ? options.getRequests() : []).filter(r => r.status === 'pending');
        let n = 0;
        for (const r of list) {
          try { options.reviewRequest(r.id, false, 'telegram-btn-rejectall:' + fromId); n++; } catch (e) {}
        }
        return send(chatId, '🗑️ Từ chối <b>' + n + '</b> yêu cầu.');
      }
      if (act === 'dokeys' || act === 'keys') {
        const list = (options.getKeys ? options.getKeys() : []).slice().sort((a,b)=>(b.created||0)-(a.created||0)).slice(0,12);
        if (!list.length) return send(chatId, '📭 Chưa có key.');
        const lines = list.map(k => {
          const d = (k.deviceHashes||[]).length; const lim = k.deviceLimit||3;
          const st = k.status==='revoked'?'🚫':(options.isExpired&&options.isExpired(k)?'⏰':'✅');
          return `${st} <code>${k.id}</code> · ${esc(k.label)} · 📱${d}/${lim}`;
        });
        return send(chatId, '🔑 <b>KEYS</b>\n' + lines.join('\n'));
      }
      if (act === 'doactive') {
        const list = (options.getKeys?options.getKeys():[]).filter(k => k.status!=='revoked' && !(options.isExpired&&options.isExpired(k))).slice(0,20);
        return send(chatId, list.length ? ('✅ <b>ACTIVE</b>\n'+list.map(k=>'• <code>'+k.id+'</code> · '+(k.label||'')).join('\n')) : '📭 Không có key active');
      }
      if (act === 'doexpired') {
        const list = (options.getKeys?options.getKeys():[]).filter(k => options.isExpired&&options.isExpired(k)).slice(0,20);
        return send(chatId, list.length ? ('⏰ <b>EXPIRED</b>\n'+list.map(k=>'• <code>'+k.id+'</code>').join('\n')) : '✅ Không có key hết hạn');
      }
      if (act === 'doclearkeys') {
        const all = options.getKeys ? options.getKeys() : [];
        let n = 0;
        for (let i = all.length - 1; i >= 0; i--) {
          if (options.isExpired && options.isExpired(all[i])) { all.splice(i,1); n++; }
        }
        try { if (options.saveKeys) options.saveKeys(); } catch(e){}
        return send(chatId, '🧹 Đã xóa <b>'+n+'</b> key hết hạn');
      }
      if (act === 'dogames') {
        const list = (gameConfigs||[]).map(g => '• <code>'+g.id+'</code> — '+(g.label||'')+(g.enabled===false?' 🔒':'')).join('\n');
        return send(chatId, '🎮 <b>GAMES</b>\n'+(list||'Trống')+'\n\nChi tiết: <code>/gamedetail id</code>');
      }
      if (act === 'dogameerr') {
        const lines = (gameConfigs||[]).map(g => {
          const f = FEEDS[g.id]; if (!f||!f.lastError) return null;
          return '• <code>'+g.id+'</code>: '+esc(String(f.lastError).slice(0,80));
        }).filter(Boolean);
        return send(chatId, lines.length ? ('⚠️ <b>LỖI</b>\n'+lines.join('\n')) : '✅ Không game lỗi');
      }
      if (act === 'doenableall' || act === 'dodisableall') {
        const on = act === 'doenableall';
        (gameConfigs||[]).forEach(g => { g.enabled = on; if (FEEDS[g.id]) FEEDS[g.id].enabled = on; });
        try { saveGameConfigs(); } catch(e){}
        return send(chatId, (on?'✅ BẬT':'🔒 TẮT')+' tất cả game');
      }
      if (act === 'doreload') {
        try {
          const loaded = loadJSON(GAMES_FILE, null);
          if (Array.isArray(loaded)) { gameConfigs.length = 0; gameConfigs.push(...loaded); initializeFeedConfigs(); }
          return send(chatId, '♻️ Reload '+gameConfigs.length+' game');
        } catch(e) { return send(chatId, '❌ '+e.message); }
      }
      if (act === 'doplans') {
        const cfg = options.getConfig();
        const ps = cfg.plans||[];
        if (!ps.length) return send(chatId, '📭 Chưa có gói');
        return send(chatId, '📦 <b>PLANS</b>\n'+ps.map(p=>'• <code>'+p.id+'</code> '+p.label+' · '+p.price+'đ · '+p.durationHours+'h · '+(p.active===false?'OFF':'ON')).join('\n'));
      }
      if (act === 'dobank') {
        const cfg = options.getConfig();
        return send(chatId, '🏦 <b>BANK</b>\n<code>'+(cfg.bankCode||'—')+'</code>\nSTK: <code>'+(cfg.bankAccount||'—')+'</code>\nChủ: '+(cfg.bankAccountName||'—')+'\n\nSửa: <code>/setbank NH STK chủ</code>');
      }
      if (act === 'dosettings' || act === 'settings') {
        const cfg = options.getConfig()||{};
        const mt = cfg.maintenance||{};
        return send(chatId, '⚙️ <b>SETTINGS</b>\nGame: '+(gameConfigs?gameConfigs.length:0)+'\nKey: '+(keys?keys.length:0)+'\nBảo trì: '+(mt.enabled?'ON':'OFF')+'\nBank: '+(cfg.bankCode||'—')+'\nSupport: '+(cfg.supportUrl||'—'));
      }
      if (act === 'mainton' || act === 'maintoff') {
        const cfg = options.getConfig();
        cfg.maintenance = cfg.maintenance || { enabled:false, message:'', lockedGames:[], lockedCommands:[] };
        cfg.maintenance.enabled = act === 'mainton';
        if (options.saveConfig) options.saveConfig(cfg);
        return send(chatId, act==='mainton' ? '🛠 Đã BẬT bảo trì' : '✅ Đã TẮT bảo trì');
      }
      if (act === 'doannounce') {
        const cfg = options.getConfig()||{};
        return send(chatId, '📣 <b>ANNOUNCE</b>\n'+(cfg.announceText||'(trống — /setannounce ...)'));
      }
      if (act === 'dostats') {
        const ks = options.getKeys?options.getKeys():[];
        const active = ks.filter(k => k.status!=='revoked' && !(options.isExpired&&options.isExpired(k))).length;
        const pending = (options.getRequests?options.getRequests():[]).filter(r=>r.status==='pending').length;
        return send(chatId, `📊 <b>STATS</b>\n🔑 Key: ${ks.length} · ✅ Active: ${active}\n⏳ Pending: ${pending}\n🎮 Game: ${(gameConfigs||[]).length}`);
      }
      if (act === 'dousers') {
        const ids = new Set();
        (botRequests||[]).forEach(r=>{ if(r.telegramId) ids.add(String(r.telegramId)); });
        (keys||[]).forEach(k=>{ if(k.telegramId) ids.add(String(k.telegramId)); });
        return send(chatId, '👥 Unique TG: <b>'+ids.size+'</b>\nKey: '+keys.length+'\nPending: '+((botRequests||[]).filter(r=>r.status==='pending').length));
      }
      if (act === 'doorders') {
        try {
          const list = (typeof orders!=='undefined' && Array.isArray(orders)?orders:[]).slice().reverse().slice(0,10);
          if (!list.length) return send(chatId, '📭 Chưa có đơn');
          return send(chatId, '💳 <b>ORDERS</b>\n'+list.map(o=>'• <code>'+o.id+'</code> '+o.status+' · '+(o.planLabel||'')+' · '+o.price+'đ').join('\n'));
        } catch(e) { return send(chatId, '📭 Orders N/A'); }
      }
      if (act === 'dologs') {
        try {
          const lines = fs.readFileSync(LOG_FILE,'utf8').split('\n').filter(Boolean).slice(-20);
          return send(chatId, '📜 <b>LOGS</b>\n<code>'+esc(lines.join('\n')).slice(0,3500)+'</code>');
        } catch(e) { return send(chatId, '❌ Không đọc log'); }
      }
      if (act === 'doping') return send(chatId, '🏓 Pong · '+new Date().toLocaleString('vi-VN'));
      if (act === 'dohelpadmin') return sendHelpAdmin(chatId, 1);
      if (act === 'dohelpadmin2') return sendHelpAdmin(chatId, 2);
      if (act === 'dohelpadmin3') return sendHelpAdmin(chatId, 3);
      return showAdminHelp(chatId, 'home');
    }
    if (data.startsWith('adm:') && !isAdmin(fromId)) {
      try { await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Chỉ admin', show_alert: true }); } catch(e){}
      return;
    }
    if (data.startsWith('adm:userinfo:') && isAdmin(fromId)) {
      const tid = data.slice('adm:userinfo:'.length);
      const p = userProfiles[tid] || { telegramId: tid };
      const uk = (keys||[]).filter(k => String(k.telegramId) === String(tid));
      return send(chatId, formatUserProfile(p, '\n🔑 Keys: '+uk.length));
    }
    // Admin quick approve / reject
    if (data.startsWith('ap:') || data.startsWith('rj:')) {
      if (!isAdmin(fromId)) {
        try { await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Không có quyền', show_alert: true }); } catch {}
        return;
      }
      const id = data.slice(3);
      const approved = data.startsWith('ap:');
      const result = options.reviewRequest(id, approved, 'telegram-btn:' + fromId);
      if (!result.ok) return send(chatId, '❌ ' + (result.error || 'Lỗi'));
      if (approved) await deliverReviewedKey(result, chatId);
      else if (result.request) await send(result.request.telegramId, '❌ Yêu cầu #' + result.request.id + ' bị từ chối.').catch(() => null);
      return send(chatId, approved ? ('✅ Đã duyệt #' + id) : ('🚫 Đã từ chối #' + id));
    }
  }

  // ===== Anti-spam: ≥5 commands in 10s → lock 30s =====
  const userCmdLog = new Map(); // fromId -> timestamps[]
  const userCmdLock = new Map(); // fromId -> unlockAt

  async function handleMessage(message) {
    if (!message || !message.chat) return;
    const from = message.from || {};
    const text = String(message.text || '').trim();
    const chatId = message.chat.id;
    const fromId = String(from.id);
    const sessions = options.getSessions();

    // Spam lock check
    const lockUntil = userCmdLock.get(fromId) || 0;
    if (Date.now() < lockUntil) {
      const left = Math.ceil((lockUntil - Date.now()) / 1000);
      return send(chatId, `🚫 Bạn đang bị tạm khoá lệnh do spam. Còn <b>${left}s</b>.`);
    }
    // Anti-spam lấy ngưỡng từ Admin → Hệ thống, mặc định 5 lệnh / 10 giây / khóa 30 giây.
    if (text.startsWith('/')) {
      const now = Date.now();
      const spamCfg = (options.getConfig && options.getConfig()) || {};
      const limit = Math.max(3, Math.min(20, Number(spamCfg.spamCmdLimit) || 5));
      const windowMs = Math.max(5000, Math.min(60000, (Number(spamCfg.spamWindowSec) || 10) * 1000));
      const lockMs = Math.max(10000, Math.min(300000, (Number(spamCfg.spamLockSec) || 30) * 1000));
      let arr = userCmdLog.get(fromId) || [];
      arr = arr.filter(t => typeof t === 'number' && now - t < windowMs);
      arr.push(now);
      userCmdLog.set(fromId, arr);
      if (arr.length >= limit) {
        userCmdLock.set(fromId, now + lockMs);
        userCmdLog.set(fromId, []);
        return send(chatId, `🚫 Bạn gửi quá nhiều lệnh trong thời gian ngắn. Tạm khóa <b>${Math.ceil(lockMs / 1000)} giây</b>.`);
      }
    }

    try {
      touchUserProfile(fromId, {
        name: displayName(from),
        username: from.username || '',
        languageCode: from.language_code || '',
        isPremium: !!from.is_premium,
        isBot: !!from.is_bot,
        lastSource: 'telegram'
      });
    } catch (e) {}

    // photo proofs
    if (message.photo?.length) {
      const session = sessions[fromId];
      if (session?.type === 'group') return createProofRequest(message, 'group');
      if (session?.type === 'payment') return createProofRequest(message, 'payment');
      if (session?.type === 'feedback_photo' || session?.type === 'feedback') return createProofRequest(message, 'feedback');
      if (session?.type === 'getkeyv2') return completeGetkeyV2(chatId, fromId);
      return send(chatId, '⚠️ Gõ /getkey, /getkeyv2 hoặc /muakeytx trước.');
    }

    if (!text) return;

    // Admin commands are web-only. Telegram is reserved for customer key purchase and delivery.
    if (text.startsWith('/') && isAdmin(fromId)) {
      const adminCmd = text.split(/\s+/)[0].toLowerCase().replace(/^\//, '').split('@')[0];
      const customerCommands = new Set(['start','help','menu','muakeytx','buy','pay','mykey','my_key','getkey','getkeyv1','getkeyv2','nhapkey','activate','feedback','infotiktok','videotiktok','cancel','support','hotro','done','id','myid']);
      if (!customerCommands.has(adminCmd)) return send(chatId, '🛠 Quản lý đã chuyển sang Index Admin: https://botvippro-production-0b00.up.railway.app/');
    }

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/^\//, '').split('@')[0];
    const args = parts.slice(1);
    const argText = text.replace(/^\/\S+\s*/, '').trim();

    if (cmd === 'cancel' && sessions[fromId]) {
      delete sessions[fromId]; options.saveSessions(sessions);
      return send(chatId, 'Đã hủy thao tác hiện tại. Nếu muốn gửi bài chia sẻ mới, gõ /feedback.');
    }

    // Feedback showcase — bước 2: nhận ghi chú riêng sau ảnh, lưu danh tính và chờ Admin duyệt.
    if (sessions[fromId]?.type === 'feedback_note') {
      const note = text.trim();
      if (note.length < 5) return send(chatId, 'Ghi chú hơi ngắn. Hãy viết ít nhất 5 ký tự, hoặc gõ /cancel để hủy.');
      const pending = sessions[fromId];
      const request = {
        id: idShort(), type: 'feedback', status: 'pending',
        telegramId: fromId, username: from.username || pending.username || '',
        userName: displayName(from) || pending.userName || 'Người dùng',
        caption: note.slice(0, 1500), proofFileId: pending.proofFileId,
        proofFileIds: (pending.proofFileIds || [pending.proofFileId]).filter(Boolean).slice(0, 10),
        shareType: 'user_testimonial', createdAt: Date.now()
      };
      options.addRequest(request);
      delete sessions[fromId]; options.saveSessions(sessions);
      await send(chatId, `✅ <b>ĐÃ GỬI BÀI CHIA SẺ</b>\nMã yêu cầu: <code>#${request.id}</code>\n\nAdmin sẽ kiểm tra ảnh và ghi chú trước khi đăng. Bạn sẽ nhận tin nhắn khi yêu cầu được duyệt.`);
      await notifyAdmins(request, request.proofFileId);
      return;
    }

    // Bot chỉ là Key Center; mọi cấu hình/quản trị nằm trong Index Admin.
    // Also allow TikTok lookup + getkeyv2 + done
    const keyCenterCommands = new Set(['start','menu','help','getkey','getkeyv1','getkeyv2','nhapkey','activate','muakeytx','buy','pay','mykey','my_key','cancel','support','hotro','feedback','infotiktok','videotiktok','done']);
    if (!keyCenterCommands.has(cmd) && !['done','xong','hoanthanh'].includes(text.toLowerCase().trim())) {
      return showUserMenu(chatId);
    }

    // Complete getkeyv2 by text "done"
    if (['done','xong','hoanthanh'].includes(text.toLowerCase().trim()) || cmd === 'done') {
      const sess = sessions[fromId];
      if (sess?.type === 'getkeyv2') return completeGetkeyV2(chatId, fromId);
    }

    // Bảo trì / khóa lệnh
    if (!isAdmin(fromId)) {
      const mt = (options.getConfig && options.getConfig().maintenance) || {};
      if (mt.enabled && Array.isArray(mt.lockedCommands) && mt.lockedCommands.includes(cmd)) {
        return send(chatId, '🛠 ' + (mt.message || 'Lệnh đang bảo trì.'));
      }
      if (mt.enabled && Array.isArray(mt.lockedCommands) && mt.lockedCommands.includes('*')) {
        return send(chatId, '🛠 ' + (mt.message || 'Bot đang bảo trì.'));
      }
    }

    if (cmd === 'start') {
      const payload = (text.split(/\s+/)[1] || '').trim();
      if (payload && /^buy[_-]/i.test(payload)) {
        const planId = payload.replace(/^buy[_-]/i, '').toLowerCase();
        return startPayment(chatId, fromId, planId);
      }
      if (['trial', 'getkey', 'getkeyv1', 'keyfree'].includes(payload.toLowerCase())) return startGroupKeyTask(chatId, fromId, from);
      if (['feedback', 'gopy', 'chiase'].includes(payload.toLowerCase())) { const ss = options.getSessions(); ss[fromId] = { type: 'feedback_photo', startedAt: Date.now() }; options.saveSessions(ss); return send(chatId, '🏆 <b>CHIA SẺ TRẢI NGHIỆM</b>\n<b>Bước 1/2:</b> Gửi ảnh chụp kết quả hoặc trải nghiệm.\n<b>Bước 2/2:</b> Gửi ghi chú ở tin nhắn tiếp theo.\nBot tự ghi nhận tài khoản Telegram; Admin duyệt trước khi đăng lên kênh. Gõ /cancel để hủy.'); }
      return showStart(chatId, displayName(from), from);
    }
    if (cmd === 'menu' || cmd === 'help') return showUserMenu(chatId);
    if (cmd === 'feedback') {
      sessions[fromId] = { type: 'feedback_photo', startedAt: Date.now() }; options.saveSessions(sessions);
      return send(chatId, '🏆 <b>CHIA SẺ TRẢI NGHIỆM</b>\n━━━━━━━━━━━━━━━━━━━━\n<b>BƯỚC 1/2 · GỬI ẢNH</b>\nGửi ảnh chụp kết quả hoặc trải nghiệm của bạn trước. Không cần ghi chú trên ảnh.\n\n<b>BƯỚC 2/2 · GHI CHÚ</b>\nSau khi bot xác nhận đã nhận ảnh, hãy gửi một tin nhắn ngắn nói về trải nghiệm/kết quả bạn muốn chia sẻ.\n\n👤 Bot tự đính kèm tên, @username và Telegram ID để Admin xác minh. Admin duyệt rồi mới đăng lên kênh.\n❌ Gõ /cancel để hủy.');
    }

    if (cmd === 'status') {
      const pending = (options.getRequests ? options.getRequests() : []).filter(r => r.telegramId === fromId && r.status === 'pending');
      if (!pending.length) return send(chatId, '✅ Không có yêu cầu chờ.');
      return send(chatId, `⏳ <b>${pending.length} yêu cầu</b>\n` + pending.map(r => `• #${r.id} ${r.type === 'payment' ? '💳' : r.type === 'reset' ? '🔄' : '🎯'}`).join('\n'));
    }

    if (cmd === 'getkey' || cmd === 'getkeyv1') {
      return startGroupKeyTask(chatId, fromId, from);
    }

    // ===== /getkeyv2 — Link4M + Index Key (max 2/day) =====
    if (cmd === 'getkeyv2') {
      return startGetkeyV2(chatId, fromId, from);
    }

    // ===== /nhapkey KEY — xác nhận key sau vượt, mở Mini App tự điền =====
    if (cmd === 'nhapkey' || cmd === 'activate') {
      const plain = (argText || args.join(' ') || '').trim();
      if (!plain) {
        return send(chatId, '🔐 <b>NHẬP KEY</b>\nCú pháp: <code>/nhapkey KEY_CỦA_BẠN</code>\n\nLấy key sau khi vượt link /getkeyv2 (trang web hiện key + nút sao chép).');
      }
      let record = null;
      try {
        if (typeof options.findKey === 'function') record = options.findKey(plain);
      } catch (e) {}
      if (!record) {
        return send(chatId, '❌ Key không hợp lệ hoặc đã hết hạn.\nCopy nguyên key từ trang nhận key rồi thử lại.');
      }
      if (record.revoked || record.status === 'revoked') return send(chatId, '❌ Key đã bị thu hồi.');
      if (record.expiresAt && record.expiresAt < Date.now()) {
        return send(chatId, '❌ Key đã hết hạn. Gõ /getkeyv2 để vượt lại hoặc /muakeytx.');
      }
      if (record.telegramId && String(record.telegramId) !== String(fromId)) {
        return send(chatId, '⛔ Key này đã được liên kết với Telegram ID khác. Liên hệ @SunNetWin nếu bạn là chủ sở hữu.');
      }
      try {
        if (typeof options.patchKey === 'function') {
          options.patchKey(record.id, { telegramId: String(fromId) });
        } else if (record.telegramId == null) {
          record.telegramId = fromId;
          if (typeof options.saveKeys === 'function') options.saveKeys();
        }
      } catch (e) {}
      const appBase = ensureHttps(process.env.PUBLIC_URL || process.env.WEB_URL || '').replace(/\/+$/, '');
      if (!appBase) {
        return send(chatId, '✅ Key hợp lệ và đã liên kết với Telegram. Nút mở trang hiện chưa khả dụng; hãy mở Index và dán key thủ công:\n<code>' + esc(plain) + '</code>');
      }
      const appUrl = appBase + '/?key=' + encodeURIComponent(plain);
      const left = record.expiresAt ? Math.max(1, Math.round((record.expiresAt - Date.now()) / 60000)) : null;
      return send(chatId,
`✅ <b>KEY HỢP LỆ — ĐÃ LƯU</b>
━━━━━━━━━━━━━━━━━━━━
🔑 <code>${esc(plain)}</code>
${left != null ? '⏱ Còn khoảng <b>' + left + ' phút</b>\n' : ''}
📱 Bấm nút bên dưới → Index <b>tự điền key</b> và UNLOCK.

Hoặc mở Index → dán key → UNLOCK.
━━━━━━━━━━━━━━━━━━━━
@SunNetWin`,
        { reply_markup: { inline_keyboard: [
          [{ text: '🎮 Mở Index (tự điền key)', web_app: { url: appUrl } }],
          [{ text: '📋 Sao chép Key', copy_text: { text: plain } }]
        ] } }
      );
    }

    // ===== TikTok commands (cooldown 30s) =====
    if (cmd === 'infotiktok' || cmd === 'infotik' || cmd === 'checktt') {
      const input = argText || args.join(' ');
      if (!input) return send(chatId, '📌 Dùng: <code>/infotiktok username</code>\nVD: <code>/infotiktok ngth.2010</code>');
      // simple per-user cooldown
      const cdKey = 'tt_' + fromId;
      const last = userCmdLog.get(cdKey) || 0;
      if (Date.now() - last < 30000) {
        const left = Math.ceil((30000 - (Date.now() - last)) / 1000);
        return send(chatId, `⏳ Cooldown còn <b>${left}s</b>.`);
      }
      userCmdLog.set(cdKey, Date.now());
      try {
        await send(chatId, '🔍 Đang lấy thông tin TikTok...');
        const info = await lookupTikTok(input);
        const lines = [
          '📱 <b>THÔNG TIN TIKTOK</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `👤 <b>${esc(info.nickname || info.username)}</b>`,
          `🔗 @${esc(info.username)}`,
          info.verified ? '✅ Đã xác minh' : '',
          info.private ? '🔒 Tài khoản riêng tư' : '',
          info.bio ? `📝 ${esc(String(info.bio).slice(0, 150))}` : '',
          `👥 Followers: <b>${info.followers != null ? fmt(info.followers) : '—'}</b>`,
          `➡️ Following: <b>${info.following != null ? fmt(info.following) : '—'}</b>`,
          `❤️ Likes: <b>${info.likes != null ? fmt(info.likes) : '—'}</b>`,
          `🎬 Videos: <b>${info.videos != null ? fmt(info.videos) : '—'}</b>`,
          info.createTime ? `📅 Tạo: ${new Date(info.createTime).toLocaleDateString('vi-VN')}` : '',
          `🌐 ${esc(info.profileUrl || '')}`
        ].filter(Boolean).join('\n');
        if (info.avatar) {
          try {
            await sendPhoto(chatId, info.avatar, { caption: lines });
          } catch {
            await send(chatId, lines);
          }
        } else {
          await send(chatId, lines);
        }
      } catch (e) {
        await send(chatId, '❌ Không lấy được: ' + esc(e.message || 'lỗi'));
      }
      return;
    }

    if (cmd === 'videotiktok' || cmd === 'videotik') {
      let input = argText || args.join(' ');
      if (/^\d{10,30}$/.test(input)) input = 'https://www.tiktok.com/video/' + input;
      if (!input || !/tiktok\.com/i.test(input)) {
        return send(chatId, '📌 Dùng: <code>/videotiktok {link hoặc ID}</code>\nVD link: <code>/videotiktok https://www.tiktok.com/@user/video/7231338487075638570</code>\nVD ID: <code>/videotiktok 7231338487075638570</code>');
      }
      const cdKey = 'ttv_' + fromId;
      const last = userCmdLog.get(cdKey) || 0;
      if (Date.now() - last < 30000) {
        const left = Math.ceil((30000 - (Date.now() - last)) / 1000);
        return send(chatId, `⏳ Cooldown còn <b>${left}s</b>.`);
      }
      userCmdLog.set(cdKey, Date.now());
      try {
        await send(chatId, '🔍 Đang lấy thông tin video...');
        // Reuse lookupTikTok oEmbed path for video
        const headers = {
          'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
          'accept-language': 'vi-VN,vi;q=0.9'
        };
        const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(input)}`;
        const r = await fetch(oembedUrl, { signal: AbortSignal.timeout(10000), headers });
        if (!r.ok) throw new Error('Không lấy được oEmbed');
        const d = await r.json();
        const lines = [
          '🎬 <b>THÔNG TIN VIDEO TIKTOK</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `📌 ${esc((d.title || '').slice(0, 200))}`,
          `👤 Author: <b>${esc(d.author_name || '—')}</b>`,
          d.author_url ? `🔗 ${esc(d.author_url)}` : '',
          d.provider_name ? `🌐 ${esc(d.provider_name)}` : '',
          `🔗 ${esc(input)}`
        ].filter(Boolean).join('\n');
        if (d.thumbnail_url) {
          try { await sendPhoto(chatId, d.thumbnail_url, { caption: lines }); }
          catch { await send(chatId, lines); }
        } else {
          await send(chatId, lines);
        }
      } catch (e) {
        await send(chatId, '❌ Không lấy được video: ' + esc(e.message || 'lỗi'));
      }
      return;
    }

    if (cmd === 'muakeytx') {
      return showBuyMenu(chatId);
    }

    if (cmd === 'pay') {
      const planId = (args[0] || '').toLowerCase();
      return startPayment(chatId, fromId, planId);
    }

    if (cmd === 'help') {
      return showStart(chatId, displayName(from), from);
    }

    if (cmd === 'resetkeytx') {
      return send(chatId, 'ℹ️ Chức năng reset key đã được gỡ. Hỗ trợ: @SunNetWin');
    }

    if (cmd === 'id' || cmd === 'myid') {
      return send(chatId, '🆔 Telegram ID:\n<code>' + fromId + '</code>\nUsername: @' + (from.username || '—'));
    }
    if (cmd === 'time' || cmd === 'gio') {
      return send(chatId, '🕐 <b>' + new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) + '</b>\nGMT+7');
    }
    if (cmd === 'check' || cmd === 'menu') {
      return send(chatId,
        '🔍 <b>MENU LỆNH USER</b>\n━━━━━━━━━━━━━━━\n' +
        '👤 /checkme · /id · /mykey\n' +
        '🌐 /checkip · /checkdevice\n' +
        '📱 /checktt @user · /infotik @user\n' +
        '📘 /checkfb link|user · /infofb\n' +
        '📸 /checkig @user\n' +
        '▶️ /checkyt @channel|link\n' +
        '📢 /thongbao · /guide · /support\n' +
        '📦 /version · /server · /checkstatus\n' +
        '🎁 /getkeyv1 · 💳 /muakeytx · 🔄 /resetkeytx'
      );
    }
    if (cmd === 'checkip' || cmd === 'ip') {
      const p = (typeof userProfiles!=='undefined' && userProfiles[fromId]) ? userProfiles[fromId] : null;
      return send(chatId, '🌐 <b>IP</b>\n<code>'+(p&&p.lastIp?p.lastIp:'Chưa có — mở Mini App 1 lần')+'</code>\n🕐 GMT+7');
    }
    if (cmd === 'checkdevice' || cmd === 'device') {
      const p = (typeof userProfiles!=='undefined' && userProfiles[fromId]) ? userProfiles[fromId] : null;
      return send(chatId, '📱 <b>THIẾT BỊ</b>\nUA: <code>'+esc(String(p&&p.lastUa||'Mở Mini App để cập nhật').slice(0,140))+'</code>\nDevice: <code>'+esc(String(p&&p.lastDeviceHash||'—').slice(0,16))+'</code>');
    }
    if (cmd === 'checkme' || cmd === 'me') {
      const p = (typeof userProfiles!=='undefined' && userProfiles[fromId]) ? userProfiles[fromId] : null;
      const userKeys = (keys||[]).filter(k => String(k.telegramId)===fromId);
      const k = userKeys[userKeys.length-1];
      return send(chatId, '👤 <b>THÔNG TIN CỦA BẠN</b>\n━━━━━━━━━━━━━━━\n🆔 <code>'+fromId+'</code>\n🏷 '+esc(uname)+'\n🔗 @'+(from.username||'—')+'\n🌐 Lang: '+(from.language_code||'—')+'\n⭐ Premium: '+(from.is_premium?'yes':'no')+'\n📡 IP: <code>'+(p&&p.lastIp||'—')+'</code>\n🔑 Key: '+(k?(k.label||'VIP'):'Chưa có')+'\n\n🎁 /getkeyv1 · 💳 /muakeytx');
    }
    if (cmd === 'checkstatus' || cmd === 'trangthai' || cmd === 'trangThai') {
      return send(chatId, '✅ <b>HỆ THỐNG</b>\n🤖 Bot online\n🎮 Game: <b>'+Object.keys(FEEDS).length+'</b>\n🔑 Key: <b>'+keys.length+'</b>\n📦 VIP FINAL');
    }
    if (cmd === 'mykey' || cmd === 'my_key') {
      const userKeys = (keys||[]).filter(k => String(k.telegramId)===fromId);
      if (!userKeys.length) return send(chatId, '🔑 Bạn chưa có key.\n🎁 /getkeyv1 · 💎 /muakeytx');
      const lines = userKeys.slice(-5).map(k => {
        const exp = k.expiresAt ? new Date(k.expiresAt).toLocaleString('vi-VN') : 'Vĩnh viễn';
        const st = k.status==='revoked'?'🚫':(options.isExpired&&options.isExpired(k)?'⏰':'✅');
        return st+' <b>'+esc(k.label||'VIP')+'</b>\n⏱ '+exp;
      });
      return send(chatId, '🔑 <b>KEY CỦA BẠN</b>\n'+lines.join('\n\n'));
    }
    if (cmd === 'guide' || cmd === 'huongdan' || cmd === 'trogiup') {
      return send(chatId, '📖 <b>HƯỚNG DẪN</b>\n1️⃣ /start → mở Mini App\n2️⃣ Nhập key → đăng nhập\n3️⃣ Chọn game xem dự đoán\n\n🎁 /getkeyv1 · 💎 /muakeytx\n🔄 /resetkeytx · 🔑 /mykey\n🔍 /check · 📱 /checktt @user');
    }
    if (cmd === 'support' || cmd === 'hotro') {
      const cfg = (options.getConfig&&options.getConfig())||{};
      return send(chatId, '💬 <b>HỖ TRỢ</b>\n'+(cfg.supportUrl||'https://t.me/SunNetWin')+'\nAdmin: @SunNetWin');
    }
    if (cmd === 'thongbao' || cmd === 'thongBao' || cmd === 'announce') {
      const cfg = (options.getConfig&&options.getConfig())||{};
      const custom = String(cfg.announceText||'').trim();
      if (custom) return send(chatId, '📢 <b>THÔNG BÁO</b>\n'+custom);
      return send(chatId, '📢 Tool ổn định · TX/MD5/Sicbo · @SunNetWin');
    }
    if (cmd === 'version' || cmd === 'ver') {
      return send(chatId, '📦 <b>VIP FINAL</b> · All-bot admin');
    }
    if (cmd === 'server') {
      return send(chatId, '🖥️ Online · Feeds: '+Object.keys(FEEDS).length+' · '+new Date().toLocaleString('vi-VN'));
    }
    // —— Check tài khoản MXH ——
    if (cmd === 'checktt' || cmd === 'infotik' || cmd === 'tiktok' || cmd === 'tt') {
      if (!argText) return send(chatId, '📌 <code>/checktt @username</code>\nhoặc link tiktok.com/@user');
      await send(chatId, '⏳ Đang check TikTok...');
      try {
        const info = await lookupTikTok(argText);
        const fmtN = n => n == null ? '—' : Number(n).toLocaleString('vi-VN');
        const created = info.createTime ? new Date(info.createTime).toLocaleString('vi-VN') : '—';
        const text =
`📱 <b>TIKTOK</b>
────────────────
👤 <b>${esc(info.nickname)}</b> ${info.verified ? '✅' : ''}
🆔 @${esc(info.username)}
${info.private ? '🔒 Private' : '🌐 Public'}
📝 ${esc((info.bio || '—').slice(0, 180))}

👥 Followers: <b>${fmtN(info.followers)}</b>
➡️ Following: <b>${fmtN(info.following)}</b>
❤️ Likes: <b>${fmtN(info.likes)}</b>
🎬 Videos: <b>${fmtN(info.videos)}</b>
📅 Tạo: ${created}
🔗 ${info.profileUrl}`;
        if (info.avatar) {
          try { await sendPhoto(chatId, info.avatar, { caption: text }); return; } catch (e) {}
        }
        return send(chatId, text);
      } catch (e) {
        return send(chatId, '❌ ' + e.message);
      }
    }
    if (cmd === 'checkfb' || cmd === 'infofb' || cmd === 'facebook' || cmd === 'fb') {
      if (!argText) return send(chatId, '📌 <code>/checkfb username</code>\nhoặc link facebook.com/...');
      await send(chatId, '⏳ Đang check Facebook...');
      try {
        const info = await lookupFacebook(argText);
        const fmtN = n => n == null ? '—' : Number(n).toLocaleString('vi-VN');
        const text =
`📘 <b>FACEBOOK</b>
────────────────
👤 <b>${esc(info.author)}</b>
📝 ${esc((info.bio || '—').slice(0, 180))}
👥 Followers/Likes: <b>${fmtN(info.followers ?? info.likes)}</b>
🔗 ${esc(info.url)}`;
        if (info.avatar) {
          try { await sendPhoto(chatId, info.avatar, { caption: text }); return; } catch (e) {}
        }
        return send(chatId, text);
      } catch (e) {
        return send(chatId, '❌ ' + e.message);
      }
    }
    if (cmd === 'checkig' || cmd === 'instagram' || cmd === 'ig') {
      if (!argText) return send(chatId, '📌 <code>/checkig @username</code>');
      await send(chatId, '⏳ Đang check Instagram...');
      try {
        const info = await lookupInstagram(argText);
        const fmtN = n => n == null ? '—' : Number(n).toLocaleString('vi-VN');
        const text =
`📸 <b>INSTAGRAM</b>
────────────────
👤 <b>${esc(info.fullName || info.username)}</b> ${info.verified ? '✅' : ''}
🆔 @${esc(info.username)}
${info.private ? '🔒 Private' : '🌐 Public'}
📝 ${esc((info.bio || '—').slice(0, 160))}

👥 Followers: <b>${fmtN(info.followers)}</b>
➡️ Following: <b>${fmtN(info.following)}</b>
🖼 Posts: <b>${fmtN(info.posts)}</b>
🔗 ${info.profileUrl}`;
        if (info.avatar) {
          try { await sendPhoto(chatId, info.avatar, { caption: text }); return; } catch (e) {}
        }
        return send(chatId, text);
      } catch (e) {
        return send(chatId, '❌ ' + e.message);
      }
    }
    if (cmd === 'checkyt' || cmd === 'youtube' || cmd === 'yt') {
      if (!argText) return send(chatId, '📌 <code>/checkyt @channel</code>\nhoặc link youtube.com/@...');
      await send(chatId, '⏳ Đang check YouTube...');
      try {
        const info = await lookupYouTube(argText);
        const text =
`▶️ <b>YOUTUBE</b>
────────────────
📺 <b>${esc(info.title)}</b>
🆔 ${esc(info.channelId || info.handle || '—')}
📝 ${esc((info.description || '—').slice(0, 160))}
🔗 ${esc(info.url)}`;
        if (info.avatar) {
          try { await sendPhoto(chatId, info.avatar, { caption: text }); return; } catch (e) {}
        }
        return send(chatId, text);
      } catch (e) {
        return send(chatId, '❌ ' + e.message);
      }
    }

    if (text.startsWith('/')) {
      return send(chatId, '❓ Lệnh không rõ. Gõ /start · /check · /checktt @user · /guide');
    }
  }

  // reviewRequest for reset type shouldn't create a key - patch behavior via wrapper
  const originalReview = options.reviewRequest;
  options.reviewRequest = function (id, approved, reviewer) {
    const req = (options.getRequests ? options.getRequests() : []).find(r => r.id === id);
    if (req && req.type === 'reset') {
      if (!req || req.status !== 'pending') return { ok: false, error: 'Yêu cầu đã xử lý hoặc không tồn tại.' };
      req.status = approved ? 'approved' : 'rejected';
      req.reviewedAt = Date.now();
      req.reviewer = String(reviewer || 'admin');
      // device reset already done in approve handler for admin cmd; also do here for safety
      if (approved) {
        const k = resolveKey(req.resetKeyPlain || '') || (options.getKeys ? options.getKeys() : []).find(x => x.id === req.resetKeyId);
        if (k) { k.deviceHashes = []; if (options.saveKeys) options.saveKeys(); }
      }
      if (options.saveRequests) {
        // requests saved inside reviewRequest normally - ensure
      }
      // persist via side effect: original list is same array
      try {
        const fsPath = null; // save handled by mark/list mutation + existing save on original
      } catch {}
      // force save requests if available
      if (typeof options.forceSaveRequests === 'function') options.forceSaveRequests();
      return { ok: true, request: req, key: null, meta: null };
    }
    return originalReview(id, approved, reviewer);
  };

  async function loop() {
    try { await tg('deleteWebhook', { drop_pending_updates: false }); } catch {}
    while (!stopped) {
      try {
        const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const update of updates || []) {
          offset = Math.max(offset, Number(update.update_id) + 1);
          try {
            if (update.message) await handleMessage(update.message);
            if (update.callback_query) await handleCallback(update.callback_query);
          } catch (e) { console.warn('[telegram] handler:', e.message); }
        }
      } catch (e) {
        console.warn('[telegram] poll:', e.message);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  const bot = {
    sendKeyToUser: async (telegramId, key, meta = {}) => send(telegramId,
`✅ <b>KEY SẴN SÀNG</b>
🔑 <code>${key}</code>
📦 ${esc(meta.label || 'VIP')} · ⏱ ${meta.durationHours || 5}h
💾 Mở Mini App và kích hoạt key.`),
    sendTextToUser: async (telegramId, text) => send(telegramId, text),
    notifyAdmins,
    stop: () => { stopped = true; }
  };
  // Telegram command keyboard: keep the main customer commands aligned with /help.
  tg('setMyCommands', { commands: [
    { command: 'start', description: 'Mở công cụ' },
    { command: 'help', description: 'Hướng dẫn lệnh' },
    { command: 'getkey', description: 'Key dùng thử qua nhiệm vụ' },
    { command: 'getkeyv2', description: 'Nhận key qua Link4M' },
    { command: 'muakeytx', description: 'Bảng giá và mua key' },
    { command: 'nhapkey', description: 'Kích hoạt key' },
    { command: 'mykey', description: 'Kiểm tra key' },
    { command: 'infotiktok', description: 'Thông tin kênh TikTok' },
    { command: 'videotiktok', description: 'Thông tin video TikTok' },
    { command: 'feedback', description: 'Gửi góp ý' },
    { command: 'cancel', description: 'Hủy thao tác' }
  ] }).catch(e => console.warn('[telegram] setMyCommands:', e.message));
  loop();
  console.log(`[telegram] cmd-only bot started; admins=${adminIds.size}`);
  return bot;
}


const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SECRET = String(process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'));
if (!process.env.JWT_SECRET) console.warn('[security] JWT_SECRET chưa đặt; token sẽ mất hiệu lực khi process khởi động lại. Hãy cấu hình JWT_SECRET cố định trên Railway.');
const ADMIN_PASSWORDS = [...new Set([process.env.ADMIN_PASSWORD, process.env.ADMIN_SECRET].map(v => String(v || '').trim()).filter(Boolean))];
const ADMIN_PASSWORD = ADMIN_PASSWORDS[0] || '';
if (!ADMIN_PASSWORDS.length) console.warn('[security] Chưa đặt ADMIN_PASSWORD (hoặc ADMIN_SECRET); đăng nhập Admin sẽ bị vô hiệu cho đến khi cấu hình biến môi trường.');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // admin session
const USER_TOKEN_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000; // user session bounded by key expiry
const POLL_MS = Math.max(5000, Number(process.env.POLL_MS || 8000));
const BRAND = 'ToolTungTung';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
// public/ (ưu tiên) hoặc index.html ở gốc repo (GitHub toolfake)
const PUBLIC_DIR = (function () {
  const a = path.join(__dirname, 'public');
  if (fs.existsSync(path.join(a, 'index.html'))) return a;
  if (fs.existsSync(path.join(__dirname, 'index.html'))) return __dirname;
  return a;
})();
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
console.log('[static] PUBLIC_DIR=', PUBLIC_DIR, 'index=', fs.existsSync(INDEX_HTML));

app.use(express.static(PUBLIC_DIR, {
  maxAge: 0,
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.get('/', (req, res) => {
  if (fs.existsSync(INDEX_HTML)) return res.sendFile(INDEX_HTML);
  res.status(500).type('text').send('index.html missing. Put file at public/index.html OR ./index.html in repo root.');
});
app.get('/health', (req, res) => res.json({ ok: true, t: Date.now(), index: fs.existsSync(INDEX_HTML) }));
app.get('/admin', (req, res) => { const f = path.join(PUBLIC_DIR, 'admin.html'); if (fs.existsSync(f)) { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); return res.sendFile(f); } return res.redirect('/admin.html'); });
app.get('/admin.html', (req, res, next) => { const f = path.join(PUBLIC_DIR, 'admin.html'); if (fs.existsSync(f)) { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); return res.sendFile(f); } return next(); });

const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'server.log');
const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const REQUESTS_FILE = path.join(DATA_DIR, 'bot_requests.json');
const USERS_FILE = path.join(DATA_DIR, 'user_profiles.json');
const BOT_SESSIONS_FILE = path.join(DATA_DIR, 'telegram_sessions.json');
const GETKEYV2_FILE = path.join(DATA_DIR, 'getkeyv2_uses.json');
const INDEX_KEYS_FILE = path.join(DATA_DIR, 'index_keys.json');

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJSON(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ===== GETKEYV2 storage (khai báo sớm để bot dùng được) =====
let getkeyv2Uses = loadJSON(GETKEYV2_FILE, {});
if (!getkeyv2Uses || typeof getkeyv2Uses !== 'object') getkeyv2Uses = {};
let indexKeys = loadJSON(INDEX_KEYS_FILE, {});
if (!indexKeys || typeof indexKeys !== 'object') indexKeys = {};
const pendingLink4m = {};       // by telegramId
const pendingLink4mByCode = {}; // by trackCode — dùng khi user mở link vượt xong
let completeGetkeyV2Hook = null; // bot gắn hàm phát key vào đây

function bangkokDayKey(ts = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
function genIndexKey() {
  return 'IDX-' + crypto.randomBytes(16).toString('hex').toUpperCase();
}
function saveGetkeyv2Uses() { try { saveJSON(GETKEYV2_FILE, getkeyv2Uses); } catch (e) {} }
function saveIndexKeys() { try { saveJSON(INDEX_KEYS_FILE, indexKeys); } catch (e) {} }
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(indexKeys)) {
    if (!v || (v.expiresAt && v.expiresAt <= now)) { delete indexKeys[k]; changed = true; }
  }
  if (changed) saveIndexKeys();
}, 120000);
function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  console.log(line.trim());
}
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function secureEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function validHttpUrl(value) {
  try { const u = new URL(String(value)); return ['http:', 'https:'].includes(u.protocol); } catch { return false; }
}
function newPlainKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnopqrstuvwxyz';
  let out = '';
  const bytes = crypto.randomBytes(36);
  for (let i = 0; i < 36; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// ---------- key registry ----------
let keys = loadJSON(KEYS_FILE, []);
if (!Array.isArray(keys)) keys = [];
keys = keys.map(k => ({
  status: 'active', deviceLimit: 1, deviceHashes: [], expiresAt: null, source: 'admin',
  ...k,
  deviceHashes: Array.isArray(k.deviceHashes) ? k.deviceHashes : []
}));
function saveKeys() { saveJSON(KEYS_FILE, keys); }
function findKey(plain) { const hash = sha256(String(plain || '').trim()); return keys.find(k => k.hash === hash) || null; }
function isExpired(key, now = Date.now()) { return key.expiresAt !== null && key.expiresAt !== undefined && Number(key.expiresAt) <= now; }
// Enforce key deviceLimit on first activation. Existing devices can reconnect; new devices need free slots.
function bindKeyDevice(key, deviceHash) {
  if (!key || !deviceHash) return { ok: false, error: 'Thiếu mã thiết bị. Hãy tải lại Index và thử lại.' };
  if (!Array.isArray(key.deviceHashes)) key.deviceHashes = [];
  const hash = String(deviceHash);
  if (key.deviceHashes.includes(hash)) return { ok: true, alreadyBound: true };
  const limit = Math.max(1, Math.min(100, Math.floor(Number(key.deviceLimit || 1))));
  if (key.deviceHashes.length >= limit) return { ok: false, error: `Key đã dùng đủ ${limit} thiết bị. Liên hệ Admin để đặt lại thiết bị.` };
  key.deviceHashes.push(hash);
  key.boundAt = key.boundAt || Date.now();
  return { ok: true, alreadyBound: false };
}
function publicKeyInfo(k) {
  const dc = (k.deviceHashes || []).length;
  return {
    id: k.id, label: k.label, created: k.created, lastUsed: k.lastUsed || null, uses: k.uses || 0, static: !!k.static,
    expiresAt: k.expiresAt ?? null, deviceLimit: Math.max(1, Number(k.deviceLimit || 1)),
    deviceCount: dc, devicesUsed: dc, expired: isExpired(k), status: k.status || 'active',
    source: k.source || 'admin', telegramId: k.telegramId || null,
    lockedIp: k.lockedIp || null, boundAt: k.boundAt || null, noReset: true
  };
}
function createKey({ key: requestedKey = '', label = 'Key VIP', durationHours = 0, expiresAt = null, deviceLimit = 1, source = 'admin', telegramId = null, static: isStatic = false } = {}) {
  let plain = String(requestedKey || '').trim();
  if (!plain) plain = newPlainKey();
  if (plain.length < 5 || plain.length > 120) throw new Error('Key phải có độ dài từ 5 đến 120 ký tự.');
  if (findKey(plain)) throw new Error('Key đã tồn tại.');
  const hours = Math.max(0, Number(durationHours || 0));
  let expiry = null;
  if (expiresAt !== null && expiresAt !== undefined && expiresAt !== '') {
    const parsed = typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime();
    if (!Number.isFinite(parsed) || parsed <= Date.now()) throw new Error('Ngày hết hạn không hợp lệ hoặc đã ở quá khứ.');
    expiry = parsed;
  } else if (hours > 0) expiry = Date.now() + hours * 60 * 60 * 1000;
  const limit = Math.max(1, Math.min(100, Math.floor(Number(deviceLimit || 1))));
  const record = {
    id: crypto.randomUUID(), hash: sha256(plain), label: String(label || 'Key VIP').slice(0, 120),
    created: Date.now(), lastUsed: null, uses: 0, expiresAt: expiry, deviceLimit: limit,
    deviceHashes: [], status: 'active', source: String(source || 'admin'), telegramId: telegramId ? String(telegramId) : null
  };
  if (isStatic || (hours === 0 && !expiry)) record.static = true;
  keys.push(record); saveKeys();
  logLine(`key created: ${record.label} | source=${record.source} | expires=${expiry || 'never'}`);
  return { plainKey: plain, record };
}

// A default key is only created for backwards compatibility. Set DEFAULT_KEY explicitly for production.
if (!keys.length && process.env.DEFAULT_KEY) {
  try { createKey({ key: process.env.DEFAULT_KEY, label: 'Default Key', source: 'environment' }); }
  catch (e) { logLine('default key initialization failed: ' + e.message); }
}

// ---------- signed sessions ----------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    if (!secureEqual(sig, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp <= Date.now()) return null;
    return payload;
  } catch { return null; }
}
const attempts = Object.create(null);
function rateLimit(ip) {
  const now = Date.now();
  attempts[ip] = (attempts[ip] || []).filter(t => now - t < 60000);
  attempts[ip].push(now);
  return attempts[ip].length <= 12;
}
function bearerToken(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token || '';
}
function requireUser(req, res, next) {
  const payload = verifyToken(bearerToken(req));
  if (!payload || payload.type !== 'user') return res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
  const k = keys.find(item => item.id === payload.keyId);
  if (!k || k.status === 'revoked' || isExpired(k)) return res.status(401).json({ error: 'Key đã hết hạn hoặc bị thu hồi.' });
  req.user = payload; req.userKey = k; next();
}
function requireAdmin(req, res, next) {
  const payload = verifyToken(bearerToken(req));
  if (!payload || payload.type !== 'admin') return res.status(401).json({ error: 'Yêu cầu quyền admin.' });
  next();
}

// ---------- configurable game feeds ----------
const DEFAULT_GAMES = [
  // Sunwin
  { id: 'sunwin', label: 'Sunwin · TX', brand: 'sunwin', brandLabel: 'Sunwin', variant: 'TX', url: 'https://apisunwin-cocalhahaha.onrender.com/api/sunwin', parser: 'sunwin', group: 'tx', icon: 'sunwin', enabled: true, playUrl: 'https://sun.win' },
  { id: 'sicbo_sunwin', label: 'Sunwin · Sicbo', brand: 'sunwin', brandLabel: 'Sunwin', variant: 'Sicbo', url: 'https://apitaixiu-6jjn.onrender.com/api/sicbo/sunwin', parser: 'max789', group: 'sicbo', icon: 'sicbo', historyUrl: 'https://apitaixiu-6jjn.onrender.com/api/sicsun/history', enabled: true, playUrl: 'https://sun.win' },
  // LC79
  { id: 'lc79_hu', label: 'LC79 · TX', brand: 'lc79', brandLabel: 'LC79', variant: 'TX', url: 'https://wtx.tele68.com/v1/tx/sessions', parser: 'lc79', group: 'tx', icon: 'lc79', enabled: true, playUrl: '' },
  { id: 'lc79_md5', label: 'LC79 · MD5', brand: 'lc79', brandLabel: 'LC79', variant: 'MD5', url: 'https://wtxmd52.tele68.com/v1/txmd5/sessions', parser: 'lc79', group: 'tx', icon: 'lc79', enabled: true, playUrl: '' },
  // Max789
  { id: 'max789_hu', label: 'Max789 · TX', brand: 'max789', brandLabel: 'Max789', variant: 'TX', url: 'https://apitaixiu-6jjn.onrender.com/max789/tx', parser: 'max789', group: 'tx', icon: 'max789', enabled: true, playUrl: '' },
  { id: 'max789_md5', label: 'Max789 · MD5', brand: 'max789', brandLabel: 'Max789', variant: 'MD5', url: 'https://max789-nqfd.onrender.com/api/taixiumd5/max789', parser: 'max789', group: 'tx', icon: 'max789', enabled: true, playUrl: '' },
  // Hitclub
  { id: 'hitclub_hu', label: 'Hitclub · TX', brand: 'hitclub', brandLabel: 'Hitclub', variant: 'TX', url: 'https://apihitclubhihi.onrender.com/api/hitclub/hu', parser: 'sunwin', group: 'tx', icon: 'hitclub', enabled: true, playUrl: '' },
  { id: 'hitclub_md5', label: 'Hitclub · MD5', brand: 'hitclub', brandLabel: 'Hitclub', variant: 'MD5', url: 'https://apihitclubhihi.onrender.com/api/hitclub/md5', parser: 'sunwin', group: 'tx', icon: 'hitclub', enabled: true, playUrl: '' },
  { id: 'sicbo_hitclub', label: 'Hitclub · Sicbo', brand: 'hitclub', brandLabel: 'Hitclub', variant: 'Sicbo', url: 'https://apitaixiu-6jjn.onrender.com/api/sicbo/hitclub', parser: 'max789', group: 'sicbo', icon: 'sicbo', enabled: true, playUrl: '' },
  // BetVIP
  { id: 'betvip_hu', label: 'BetVIP · TX', brand: 'betvip', brandLabel: 'BetVIP', variant: 'TX', url: 'https://apitaixiu-6jjn.onrender.com/betvip/tx', parser: 'max789', group: 'tx', icon: 'betvip', enabled: true, playUrl: '' },
  { id: 'betvip_md5', label: 'BetVIP · MD5', brand: 'betvip', brandLabel: 'BetVIP', variant: 'MD5', url: 'https://apitaixiu-6jjn.onrender.com/betvip/md5', parser: 'max789', group: 'tx', icon: 'betvip', enabled: true, playUrl: '' },
  // B52
  { id: 'b52_tx', label: 'B52 · TX', brand: 'b52', brandLabel: 'B52', variant: 'TX', url: 'https://apitaixiu-6jjn.onrender.com/b52/history', parser: 'b52hist', group: 'tx', icon: 'b52', enabled: true, playUrl: '' },
  { id: 'sicbo_b52', label: 'B52 · Sicbo', brand: 'b52', brandLabel: 'B52', variant: 'Sicbo', url: 'https://apitaixiu-6jjn.onrender.com/api/sicbo/b52', parser: 'max789', group: 'sicbo', icon: 'sicbo', historyUrl: 'https://apitaixiu-6jjn.onrender.com/api/sicbo/history', enabled: true, playUrl: '' },
  
];


let gameConfigs = loadJSON(GAMES_FILE, null);
if (!Array.isArray(gameConfigs)) gameConfigs = DEFAULT_GAMES.map(g => ({ ...g }));
if (!gameConfigs.some(g => g.id === 'max789_md5' || (g.parser === 'max789' && g.id === 'max789_md5'))) {
  const mx = DEFAULT_GAMES.find(g => g.id === 'max789_md5');
  if (mx) gameConfigs.push({ ...mx });
}
for (const def of DEFAULT_GAMES) {
  if (!gameConfigs.some(g => g.id === def.id)) gameConfigs.push({ ...def });
}

// Seed iconUrl mặc định theo brand nếu thiếu
(function seedGameIcons() {
  const map = {
    sunwin: '/icons/sunwin.jpg',
    hitclub: '/icons/hitclub.jpg',
    max789: '/icons/max789.jpg',
    lc79: '/icons/lc79.jpg',
    b52: '/icons/b52.jpg',
    betvip: '/icons/max789.jpg'
  };
  let changed = false;
  for (const g of gameConfigs) {
    if (g.iconUrl) continue;
    const b = String(g.brand || g.id || '').toLowerCase();
    for (const k of Object.keys(map)) {
      if (b.includes(k) || String(g.id).includes(k)) {
        g.iconUrl = map[k];
        changed = true;
        break;
      }
    }
  }
  if (changed) try { saveGameConfigs(); } catch (e) {}
})();



const FEEDS = Object.create(null);
function createFeed(config) {
  const parser = config.parser || 'lc79';
  const engine = new Engine();
  return { id: config.id, label: config.label, url: config.url, parser, table: config.table || '', playUrl: config.playUrl || '', group: config.group || 'tx', icon: config.icon || '', historyUrl: config.historyUrl || '', enabled: config.enabled !== false,
    engine, history: [], accuracyHistory: [], lastSession: null, pendingPred: null,
    correct: 0, total: 0, lastLive: null, lastEnsemble: null, _seen: [], lastError: null };
}
function saveGameConfigs() { saveJSON(GAMES_FILE, gameConfigs); }
function initializeFeedConfigs() {
  for (const key of Object.keys(FEEDS)) delete FEEDS[key];
  for (const g of gameConfigs) {
    if (!g || !/^[a-z0-9_-]{2,32}$/i.test(String(g.id || '')) || !validHttpUrl(g.url)) continue;
    g.id = String(g.id); g.label = String(g.label || g.id); g.parser = ['sunwin','max789','b52hist'].includes(g.parser) ? g.parser : 'lc79'; g.table = g.table || ''; g.playUrl = String(g.playUrl || g.play_url || g.gameLink || '').trim().slice(0, 500); g.group = g.group || (g.parser === 'tx' ? 'tx' : 'tx'); g.icon = g.icon || ''; g.historyUrl = g.historyUrl || ''; g.brand = g.brand || g.id; g.brandLabel = g.brandLabel || g.label; g.variant = g.variant || ''; g.enabled = g.enabled !== false;
    FEEDS[g.id] = createFeed(g);
  }
}
initializeFeedConfigs();

function parseSunwin(data) {
  let full = [];
  if (Array.isArray(data)) full = data;
  else if (Array.isArray(data?.data)) full = data.data;
  else if (Array.isArray(data?.list)) full = data.list;
  else if (Array.isArray(data?.history)) full = data.history;
  else if (Array.isArray(data?.Lich_su)) full = data.Lich_su;
  else if (data && typeof data === 'object') full = [data];
  const rows = full.map(item => {
    if (!item || typeof item !== 'object') return null;
    let dice = item.xuc_xac || item.dices || item.xucxac || item.dice || null;
    if (!dice) {
      dice = [
        Number(item.xuc_xac1 ?? item.Xuc_xac_1 ?? item.dice1 ?? 0),
        Number(item.xuc_xac2 ?? item.Xuc_xac_2 ?? item.dice2 ?? 0),
        Number(item.xuc_xac3 ?? item.Xuc_xac_3 ?? item.dice3 ?? 0)
      ];
    }
    if (Array.isArray(dice)) dice = dice.map(Number);
    const sum = Number(item.Tong ?? item.tong ?? item.sum ?? item.point ?? (Array.isArray(dice) ? dice.reduce((a,b)=>a+Number(b||0),0) : 0));
    let char = sum >= 11 ? 'T' : 'X';
    const raw = String(item.ket_qua || item.Ket_qua || item.ketqua || item.result || item.outcome || '').toLowerCase();
    if (raw.includes('tai') || raw.includes('tài') || raw === 't') char = 'T';
    else if (raw.includes('xiu') || raw.includes('xỉu') || raw === 'x') char = 'X';
    const session = pickSessionId(item);
    return session != null ? { session, sum, char, dice } : null;
  }).filter(Boolean);
  return normalizeSessions(rows);
}
function parseLC79(data) {
  let full = [];
  if (Array.isArray(data)) full = data;
  else if (Array.isArray(data?.list)) full = data.list;
  else if (Array.isArray(data?.sessions)) full = data.sessions;
  else if (Array.isArray(data?.data)) full = data.data;
  else if (Array.isArray(data?.history)) full = data.history;
  else if (Array.isArray(data?.Lich_su)) full = data.Lich_su;
  else full = data ? [data] : [];
  const rows = full.map(item => {
    if (!item || typeof item !== 'object') return null;
    let dice = item.dices || item.dice || item.xuc_xac || item.xucxac || null;
    if (!dice) {
      dice = [
        Number(item.xuc_xac1 ?? item.Xuc_xac_1 ?? item.dice1 ?? 0),
        Number(item.xuc_xac2 ?? item.Xuc_xac_2 ?? item.dice2 ?? 0),
        Number(item.xuc_xac3 ?? item.Xuc_xac_3 ?? item.dice3 ?? 0)
      ];
    }
    if (Array.isArray(dice)) dice = dice.map(Number);
    const sum = Number(item.point ?? item.sum ?? item.total ?? item.Tong ?? item.tong ?? (Array.isArray(dice) ? dice.reduce((a,b)=>a+Number(b||0),0) : 0));
    const raw = String(item.ket_qua || item.Ket_qua || item.ketqua || item.result || item.outcome || '').toLowerCase();
    let char = sum >= 11 ? 'T' : 'X';
    if (raw.includes('tai') || raw.includes('tài') || raw === 't') char = 'T';
    else if (raw.includes('xiu') || raw.includes('xỉu') || raw === 'x') char = 'X';
    const session = pickSessionId(item);
    return session != null ? { session, sum, char, dice } : null;
  }).filter(Boolean);
  return normalizeSessions(rows);
}
function parseFeedData(feed, data) {
  let list = [];
  if (feed.parser === 'sunwin') list = parseSunwin(data);
  
  else if (feed.parser === 'max789') list = parseMax789(data);
  else if (feed.parser === 'b52hist') list = parseB52Hist(data);
  else list = parseLC79(data);
  // Luôn deep-scan để bắt phiên MỚI NHẤT nếu parser bỏ sót nhánh JSON
  try {
    const deep = extractRowsFromAny(data);
    if (deep.length) {
      if (!list.length) return deep;
      const a = sessionNum(list[0].session) || 0;
      const b = sessionNum(deep[0].session) || 0;
      if (b > a) return deep;
      // merge unique by session
      const map = new Map();
      for (const r of [...deep, ...list]) map.set(String(r.session), r);
      return normalizeSessions([...map.values()]);
    }
  } catch (e) {}
  return list;
}

function parseB52Hist(data) {
  // { Total, Data: [ { Phien, Xuc_xac_1..3, Tong, Ket_qua } ] } or Lich_su
  let rows = [];
  if (Array.isArray(data)) rows = data;
  else if (Array.isArray(data?.Data)) rows = data.Data;
  else if (Array.isArray(data?.Lich_su)) rows = data.Lich_su;
  else if (Array.isArray(data?.data)) rows = data.data;
  else if (data && typeof data === 'object' && (data.Phien || data.phien)) rows = [data];
  return rows.map(item => {
    const dice = [
      Number(item.Xuc_xac_1 ?? item.xuc_xac1 ?? item.xuc_xac?.[0] ?? 0),
      Number(item.Xuc_xac_2 ?? item.xuc_xac2 ?? item.xuc_xac?.[1] ?? 0),
      Number(item.Xuc_xac_3 ?? item.xuc_xac3 ?? item.xuc_xac?.[2] ?? 0)
    ];
    const sum = Number(item.Tong ?? item.tong ?? dice.reduce((a,b)=>a+b,0));
    const raw = String(item.Ket_qua || item.ket_qua || '').toLowerCase();
    let char = sum >= 11 ? 'T' : 'X';
    if (raw.includes('tai') || raw === 't') char = 'T';
    else if (raw.includes('xiu') || raw.includes('xỉu') || raw === 'x') char = 'X';
    else if (raw.includes('bao')) char = sum >= 11 ? 'T' : 'X'; // triple still map TX by sum
    const isBao = dice[0] === dice[1] && dice[1] === dice[2] && dice[0] > 0;
    return {
      session: item.Phien ?? item.phien ?? item.id,
      sum, char, dice, isBao,
      vi: dice.filter(Boolean).join('-')
    };
  }).filter(i => i.session !== undefined && i.session !== null && i.session !== '');
}


/** Max789 MD5: 1 object { phien_truoc, ket_qua, pattern: "ttxxt...", phien_hien_tai, xuc_xac1..3, tong } */
function parseMax789(data) {
  const item = Array.isArray(data) ? data[0] : (data?.data && !Array.isArray(data.data) ? data.data : data);
  if (!item || typeof item !== 'object') return [];
  const pattern = String(item.pattern || item.cau || item.history || '').toLowerCase().replace(/[^tx]/g, '');
  const phienTruoc = item.phien_truoc ?? item.phienTruoc ?? item.session_prev ?? item.Phien ?? item.phien;
  const phienNow = item.phien_hien_tai ?? item.phienHienTai ?? item.session ?? item.Phien;
  const dice = [
    Number(item.xuc_xac1 ?? item.Xuc_xac_1 ?? item.dice1 ?? 0),
    Number(item.xuc_xac2 ?? item.Xuc_xac_2 ?? item.dice2 ?? 0),
    Number(item.xuc_xac3 ?? item.Xuc_xac_3 ?? item.dice3 ?? 0)
  ];
  const sum = Number(item.tong ?? item.Tong ?? item.sum ?? dice.reduce((a, b) => a + b, 0));
  const raw = String(item.ket_qua || item.Ket_qua || item.ketqua || item.result || '').toLowerCase();
  let lastChar = sum >= 11 ? 'T' : 'X';
  if (raw.includes('tai') || raw === 't') lastChar = 'T';
  else if (raw.includes('xiu') || raw.includes('xỉu') || raw === 'x') lastChar = 'X';

  // Build history from pattern (oldest → newest in string left→right typically)
  // pattern ends with latest; use indices relative to phien_truoc
  const list = [];
  if (pattern.length >= 2) {
    const base = Number(phienTruoc);
    const hasBase = Number.isFinite(base);
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i] === 't' ? 'T' : 'X';
      // last char of pattern should align with phien_truoc result
      const sess = hasBase ? (base - (pattern.length - 1 - i)) : (`p-${i}`);
      list.push({ session: sess, char: ch, sum: i === pattern.length - 1 ? sum : null, dice: i === pattern.length - 1 ? dice : null });
    }
    // force last to match ket_qua
    if (list.length) {
      list[list.length - 1].char = lastChar;
      list[list.length - 1].sum = sum;
      list[list.length - 1].dice = dice;
      if (hasBase) list[list.length - 1].session = base;
    }
  } else if (phienTruoc !== undefined && phienTruoc !== null && phienTruoc !== '') {
    const isBao = dice[0] > 0 && dice[0] === dice[1] && dice[1] === dice[2];
    list.push({ session: phienTruoc, char: lastChar, sum, dice, isBao, vi: dice.join('-') });
  }
  // newest first
  return normalizeSessions(list);
}



function nextSessionNumber(session) {
  if (/^\d+$/.test(String(session))) return String(Number(session) + 1);
  return null;
}
function sessionEquals(a, b) { return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b); }
function sessionNum(s) {
  const n = Number(String(s).replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : null;
}
/** Chuẩn hóa list phiên: unique + mới nhất TRƯỚC (session số lớn hơn = mới hơn) */
function normalizeSessions(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const map = new Map();
  for (const item of list) {
    if (!item || item.session === undefined || item.session === null || item.session === '') continue;
    const key = String(item.session);
    // giữ bản ghi có sum/dice đầy đủ hơn nếu trùng
    const prev = map.get(key);
    if (!prev || (item.sum != null && prev.sum == null) || (item.dice && !prev.dice)) map.set(key, item);
  }
  const arr = [...map.values()];
  const allNum = arr.every(x => sessionNum(x.session) != null);
  if (allNum) arr.sort((a, b) => sessionNum(b.session) - sessionNum(a.session));
  return arr;
}
function pickSessionId(item) {
  if (!item || typeof item !== 'object') return null;
  const keys = ['phien','Phien','PHIEN','session','session_id','sessionId','phien_id','PhienId','game_round','issue','period','round','round_id','id','Phien_Id','phienHienTai','phien_hien_tai','currentSession','current_session'];
  for (const k of keys) {
    if (item[k] !== undefined && item[k] !== null && item[k] !== '') return item[k];
  }
  return null;
}
/** Quét sâu toàn JSON lấy mọi số phiên + mảng lịch sử ẩn */
function deepCollectSessions(node, out, depth) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) {
    // nếu mảng object có phien → coi là history
    for (const el of node) deepCollectSessions(el, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const sid = pickSessionId(node);
  if (sid != null && sid !== '') {
    const n = sessionNum(sid);
    if (n != null && n > 1000) out.nums.push(n);
    out.items.push(node);
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && (typeof v === 'object')) deepCollectSessions(v, out, depth + 1);
  }
}
function extractRowsFromAny(data) {
  const out = { nums: [], items: [] };
  deepCollectSessions(data, out, 0);
  // map items → rows chuẩn
  const rows = [];
  const seen = new Set();
  for (const item of out.items) {
    const session = pickSessionId(item);
    if (session == null || session === '') continue;
    const key = String(session);
    if (seen.has(key)) continue;
    seen.add(key);
    let dice = item.xuc_xac || item.dices || item.xucxac || item.dice || null;
    if (!dice) {
      dice = [
        Number(item.xuc_xac1 ?? item.Xuc_xac_1 ?? item.dice1 ?? item.xx1 ?? 0),
        Number(item.xuc_xac2 ?? item.Xuc_xac_2 ?? item.dice2 ?? item.xx2 ?? 0),
        Number(item.xuc_xac3 ?? item.Xuc_xac_3 ?? item.dice3 ?? item.xx3 ?? 0)
      ];
    }
    if (Array.isArray(dice)) dice = dice.map(Number);
    const sum = Number(item.Tong ?? item.tong ?? item.sum ?? item.point ?? item.total ?? (Array.isArray(dice) ? dice.reduce((a,b)=>a+Number(b||0),0) : 0));
    let char = sum >= 11 ? 'T' : 'X';
    const raw = String(item.ket_qua || item.Ket_qua || item.ketqua || item.result || item.outcome || item.kq || '').toLowerCase();
    if (raw.includes('tai') || raw.includes('tài') || raw === 't') char = 'T';
    else if (raw.includes('xiu') || raw.includes('xỉu') || raw === 'x') char = 'X';
    rows.push({ session, sum, char, dice });
  }
  let list = normalizeSessions(rows);
  // nếu deep scan có max lớn hơn list[0] — ưu tiên max
  if (out.nums.length) {
    const maxN = Math.max(...out.nums);
    if (list.length) {
      const top = sessionNum(list[0].session);
      if (top == null || maxN > top) {
        // tìm row đúng max
        const hit = list.find(r => sessionNum(r.session) === maxN);
        if (hit) list = [hit, ...list.filter(r => r !== hit)];
        else list = [{ session: maxN, sum: null, char: 'T', dice: null }, ...list];
      }
    } else {
      list = [{ session: maxN, sum: null, char: 'T', dice: null }];
    }
  }
  return list;
}



// Load trained state after dynamic feed definitions are ready.
const savedState = loadJSON(STATE_FILE, null);
if (savedState?.feeds) {
  for (const [id, f] of Object.entries(FEEDS)) {
    const st = savedState.feeds[id];
    if (!st) continue;
    try { f.engine.loadState(st.state); } catch {}
    f.history = Array.isArray(st.history) ? st.history.slice(0, 5000) : [];
    f.accuracyHistory = Array.isArray(st.accuracyHistory) ? st.accuracyHistory.slice(0, 10000) : [];
    f.lastSession = st.lastSession ?? null;
    f.correct = Number(st.correct || 0); f.total = Number(st.total || 0);
    f.pendingPred = st.pendingPred || null;
    f.lastLive = st.lastLive || f.history[0] || null;
    f._seen = f.history.map(h => String(h.session)).slice(0, 5000);
  }
  logLine('resumed game state: ' + Object.keys(savedState.feeds).join(', '));
}


/** Sicbo: VỊ = đoán TỔNG 3 xúc xắc (3–18). Bão hiếm → ít/không đoán bão. TX vẫn là cửa chính. */
function enhanceSicbo(feed, ensemble) {
  const hist = feed.history || [];
  const rows = hist.filter(h => Number.isFinite(Number(h.sum))).slice(0, 120);

  // 1) Cửa Tài / Xỉu từ ensemble
  const pr = String(ensemble.predictedResult || '').toUpperCase();
  const isTai = pr.includes('TÀI') || pr.includes('TAI') || (pr === 'T') || (pr.includes('T') && !pr.includes('X'));
  const sideLabel = isTai ? 'TÀI' : 'XỈU';
  // Tài: >10 (11–18) · Xỉu: ≤10 (3–10)
  const lo = isTai ? 11 : 3;
  const hi = isTai ? 18 : 10;
  const sideSums = [];
  for (let s = lo; s <= hi; s++) sideSums.push(s);

  // Seed theo phiên để 2 phiên liên tiếp không ra cùng 1 bộ vị
  const sessSeed = String(feed.openSession || feed.lastLive?.session || feed.history?.[0]?.session || Date.now());
  let seed = 0;
  for (let i = 0; i < sessSeed.length; i++) seed = (seed * 31 + sessSeed.charCodeAt(i)) >>> 0;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  // Trọng số: phiên mới nặng + phạt xuất lý thuyết xúc xắc (tổng gần 10–11 nhiều hơn)
  const diceProb = { 3:1,4:3,5:6,6:10,7:15,8:21,9:25,10:27,11:27,12:25,13:21,14:15,15:10,16:6,17:3,18:1 };
  const weighted = {};
  for (const s of sideSums) weighted[s] = (diceProb[s] || 1) * 0.15;

  // Lịch sử gần: boost tổng xuất hiện, phạt tổng vừa ra (anti-repeat ngắn hạn)
  const recentSums = rows.slice(0, 12).map(r => Math.round(Number(r.sum))).filter(s => s >= 3 && s <= 18);
  rows.slice(0, 50).forEach((r, i) => {
    const sm = Math.round(Number(r.sum));
    if (sm < lo || sm > hi) return;
    weighted[sm] = (weighted[sm] || 0) + (2.2 + (50 - i) * 0.12);
  });
  // Phạt nhẹ 3 tổng vừa mới ra để vị đổi theo phiên
  recentSums.slice(0, 3).forEach((sm, i) => {
    if (sm >= lo && sm <= hi) weighted[sm] = Math.max(0.01, (weighted[sm] || 0) * (0.35 - i * 0.08));
  });

  // Tránh lặp lại đúng bộ vị của lần dự đoán trước
  const prevTop = (feed.lastEnsemble && feed.lastEnsemble.sicbo && Array.isArray(feed.lastEnsemble.sicbo.viTop3))
    ? feed.lastEnsemble.sicbo.viTop3.map(Number) : [];

  // Chọn top 3 bằng weighted random (không chỉ sort cứng → đa dạng hơn)
  const pool = sideSums.map(s => ({ sum: s, w: Math.max(0.01, weighted[s] || 0.01) }));
  const pickOne = (arr) => {
    const total = arr.reduce((a, b) => a + b.w, 0) || 1;
    let r = rnd() * total;
    for (const item of arr) {
      r -= item.w;
      if (r <= 0) return item.sum;
    }
    return arr[arr.length - 1].sum;
  };
  const viTop3 = [];
  const poolCopy = pool.slice();
  while (viTop3.length < 3 && poolCopy.length) {
    const s = pickOne(poolCopy);
    if (!viTop3.includes(s)) viTop3.push(s);
    const idx = poolCopy.findIndex(x => x.sum === s);
    if (idx >= 0) poolCopy.splice(idx, 1);
  }
  // Nếu trùng nguyên bộ với lần trước → xoay 1 vị
  if (prevTop.length === 3 && viTop3.length === 3 &&
      prevTop.slice().sort().join() === viTop3.slice().sort().join()) {
    const alt = sideSums.filter(s => !viTop3.includes(s));
    if (alt.length) viTop3[2] = alt[Math.floor(rnd() * alt.length)];
  }
  if (!viTop3.length) {
    viTop3.push(...(isTai ? [14, 12, 16] : [8, 6, 9]));
  }

  const viTong = viTop3[0];
  const totalW = pool.reduce((a, b) => a + b.w, 0) || 1;
  const topW = weighted[viTong] || 0;
  const viConf = Math.round(Math.min(74, Math.max(34, (topW / totalW) * 100 + 22)));

  function diceForSum(target) {
    const combos = [];
    for (let a = 1; a <= 6; a++)
      for (let b = 1; b <= 6; b++)
        for (let c = 1; c <= 6; c++)
          if (a + b + c === target) combos.push([a, b, c]);
    if (!combos.length) return null;
    // Xáo nhẹ theo seed phiên
    combos.sort((A, B) => (rnd() - 0.5));
    const recent = rows.slice(0, 20).map(r => (Array.isArray(r.dice) ? r.dice.join('-') : ''));
    combos.sort((A, B) => recent.filter(x => x === B.join('-')).length - recent.filter(x => x === A.join('-')).length);
    return combos[0];
  }
  const diceHints = viTop3.map(sm => ({ sum: sm, dice: diceForSum(sm) }));

  // Format gọn: TÀI · Vị: 11-16-18  (không ngoặc)
  const viClean = viTop3.slice(0, 3).join('-');
  const viText = `${sideLabel} · Vị: ${viClean}`;

  return {
    ...ensemble,
    predictedResult: sideLabel,
    gameType: 'sicbo',
    sicbo: {
      side: sideLabel,
      sideRange: isTai ? '11-18' : '3-10',
      viTong,
      viConf,
      viTop3,
      diceHints,
      viText,
      note: viText
    }
  };
}

async function pollFeed(id) {
  const f = FEEDS[id];
  if (!f || !f.enabled || f.polling) return;
  f.polling = true;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    const response = await fetch(f.url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    let list = parseFeedData(f, data);
    // Sicbo result is determined from the three-dice total, not a text label returned by a provider.
    if (String(f.group || '').toLowerCase() === 'sicbo' && Array.isArray(list)) {
      list = list.map(row => {
        const sum = Number(row && row.sum);
        if (Number.isFinite(sum) && sum >= 3 && sum <= 18) return { ...row, char: sum > 10 ? 'T' : 'X' };
        return row;
      });
    }
    list = normalizeSessions(list);
    if (!list.length) throw new Error('API không trả về danh sách phiên phù hợp');
    // list[0] = phiên MỚI NHẤT (số lớn nhất)
    const latest = list[0];
    f.lastPolledAt = Date.now();
    f.rawMaxSession = sessionNum(latest.session);
    f.rawTop5 = list.slice(0, 5).map(x => String(x.session));
    // Nếu API trả phiên hiện tại (đang mở) riêng
    const openSess = data && (data.phien_hien_tai ?? data.phienHienTai ?? data.current_session ?? data.currentSession);
    if (openSess != null && openSess !== '') f.openSession = openSess;
    else f.openSession = nextSessionNumber(latest.session);
    if (sessionEquals(f.lastSession, latest.session)) {
      f.lastError = null;
      f.lastLive = f.history.find(h => sessionEquals(h.session, latest.session)) || { ...latest, ts: Date.now() };
      return;
    }
    const seen = new Set((f._seen || []).map(String));
    const chronological = [...list].reverse().filter(item => !seen.has(String(item.session)));
    for (const item of chronological) {
      let scoreRow = null;
      if (f.pendingPred) {
        const expected = f.pendingPred.targetSession;
        const shouldScore = expected !== null && expected !== undefined
          ? sessionEquals(expected, item.session)
          : !sessionEquals(f.pendingPred.sourceSession, item.session);
        if (shouldScore) {
          const isCorrect = f.pendingPred.predicted === item.char;
          f.total++;
          if (isCorrect) f.correct++;
          scoreRow = { session: item.session, predicted: f.pendingPred.predicted, actual: item.char, isCorrect, ts: Date.now(), sourceSession: f.pendingPred.sourceSession };
          f.accuracyHistory.unshift(scoreRow);
          f.accuracyHistory = f.accuracyHistory.slice(0, 10000);
          f.pendingPred = null;
        } else if (expected !== null && /^\d+$/.test(String(expected)) && /^\d+$/.test(String(item.session)) && Number(item.session) > Number(expected)) {
          f.accuracyHistory.unshift({ session: item.session, predicted: f.pendingPred.predicted, actual: item.char, isCorrect: null, skipped: true, ts: Date.now(), sourceSession: f.pendingPred.sourceSession });
          f.accuracyHistory = f.accuracyHistory.slice(0, 10000);
          f.pendingPred = null;
        }
      }
      f.engine.addResult(item.char, item.sum, item.goodRoad ? { goodRoad: item.goodRoad } : undefined);
      const row = { session: item.session, char: item.char, sum: item.sum, dice: item.dice, isBao: item.isBao, vi: item.vi, ts: Date.now() };
      if (scoreRow) { row.prediction = scoreRow.predicted; row.isCorrect = scoreRow.isCorrect; }
      f.history.unshift(row);
      f.history = f.history.slice(0, 5000);
      seen.add(String(item.session));
    }
    f._seen = [...seen].slice(-5000);

    // Nếu có historyUrl (sicbo) — hydrate thêm lịch sử
    if (f.historyUrl && f.history.length < 15) {
      try {
        const hr = await fetch(f.historyUrl, { signal: ctrl.signal, headers: { accept: 'application/json' } });
        if (hr.ok) {
          const hd = await hr.json();
          const hlist = parseB52Hist(hd);
          const seen = new Set((f._seen || []).map(String));
          for (const item of [...hlist].reverse()) {
            if (seen.has(String(item.session))) continue;
            f.engine.addResult(item.char, item.sum, undefined);
            f.history.unshift({ session: item.session, char: item.char, sum: item.sum, dice: item.dice, isBao: item.isBao, vi: item.vi, ts: Date.now() });
            seen.add(String(item.session));
          }
          f.history = f.history.slice(0, 5000);
          f._seen = [...seen].slice(-5000);
        }
      } catch (_) {}
    }

    f.lastSession = latest.session;
    f.lastLive = f.history.find(h => sessionEquals(h.session, latest.session)) || { ...latest, ts: Date.now() };
    const ensemble = f.engine.getEnsemblePrediction();
    f.lastEnsemble = ensemble;
    const pr = String(ensemble.predictedResult || '').toUpperCase();
    let predicted = 'X';
    if (pr === 'TÀI' || pr === 'TAI' || pr === 'T') predicted = 'T';
    else if (pr === 'XỈU' || pr === 'XIU' || pr === 'X') predicted = 'X';
    else if (pr === 'BANKER' || pr === 'B' || pr === 'CAI') predicted = 'B';
    else if (pr === 'PLAYER' || pr === 'P' || pr === 'CON') predicted = 'P';
    else if (f.parser === 'tx') predicted = 'B';
    const target = f.openSession != null ? String(f.openSession) : nextSessionNumber(latest.session);
    f.pendingPred = { sourceSession: String(latest.session), targetSession: target, predicted, createdAt: Date.now() };
    f.lastError = null;
  } catch (e) {
    f.lastError = e.message || String(e);
    logLine(`poll ${id} error: ${f.lastError}`);
  } finally { clearTimeout(timeout); f.polling = false; }
}
function saveState() {
  const out = { updated: Date.now(), feeds: {} };
  for (const [id, f] of Object.entries(FEEDS)) {
    out.feeds[id] = {
      state: f.engine.saveState(), history: f.history.slice(0, 5000), accuracyHistory: f.accuracyHistory.slice(0, 10000),
      lastSession: f.lastSession, correct: f.correct, total: f.total, pendingPred: f.pendingPred, lastLive: f.lastLive
    };
  }
  saveJSON(STATE_FILE, out);
}

// ---------- bot settings and moderation queue ----------
let botSettings = loadJSON(SETTINGS_FILE, null) || {
  telegramUsername: '',
  groupTaskText: 'Cần rải quảng cáo vào 3 nhóm bất kì.\n\n📌 Cách làm:\n1) Sao chép câu promo admin cung cấp\n2) Vào 3 nhóm bất kì và gửi tin nhắn\n3) Chụp màn hình 3 tin nhắn vừa gửi\n4) Gửi 3 ảnh vào đây cho Bot duyệt\n\n⚠️ Lưu ý:\n- Ảnh rõ, thể hiện đã gửi thành công\n- Phải đủ 3 ảnh từ 3 nhóm khác nhau',
  groupPromoText: '@SunNetWin tool dự đoán TX VIP — getkey miễn phí, hỗ trợ 24/7',
  groupTaskPhotos: 3,
  groupTaskTimeoutSec: 300,
  supportUrl: 'https://t.me/SunNetWin',
  watermarkText: 'SunWin · MD5 · HitClub · ToolTungTung',
  siteTitle: 'ToolTungTung',
  maintenance: {
    enabled: false,
    message: 'Hệ thống đang bảo trì, vui lòng quay lại sau.',
    lockedGames: [],
    lockedCommands: []
  },
  bankCode: '', bankAccount: '', bankAccountName: '', plans: [],
  getkeyv2MaxPerDay: 2,
  getkeyv2LinkMinutes: 5,
  getkeyv2KeyHours: 18,
  indexKeyMinutes: 30,
  link4mBaseUrl: 'https://link4m.co/api-shorten/v2',
  link4mApiToken: '',
  telegramBotUrl: '',
  feedbackChannelId: '',
  spamCmdLimit: 5,
  spamWindowSec: 10,
  spamLockSec: 30,
  predictionCalibrationEnabled: true,
  predictionConfidenceCap: 68,
  predictionMinSamples: 12
};
function normalizeSettings(value) {
  const v = value || {};
  let plans = Array.isArray(v.plans) ? v.plans.map(p => ({
    id: String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24),
    label: String(p.label || '').trim().slice(0, 80),
    price: Math.max(0, Math.floor(Number(p.price || 0))),
    durationHours: Math.max(0, Math.floor(Number(p.durationHours || 0))),
    deviceLimit: Math.max(1, Math.min(20, Math.floor(Number(p.deviceLimit || 3)))),
    active: p.active !== false,
    hot: !!p.hot,
    note: String(p.note || '').trim().slice(0, 120)
  })).filter(p => p.id && p.label && p.price > 0 && p.durationHours > 0) : [];
  if (!plans.length) {
    plans = [
      { id: '1d', label: '1 ngày', price: 30000, durationHours: 24, deviceLimit: 3, active: true, hot: false, note: '' },
      { id: '3d', label: '3 ngày', price: 70000, durationHours: 72, deviceLimit: 3, active: true, hot: true, note: 'Phổ biến' },
      { id: '1w', label: '1 tuần', price: 150000, durationHours: 168, deviceLimit: 3, active: true, hot: false, note: '' },
      { id: '1m', label: '1 tháng', price: 400000, durationHours: 720, deviceLimit: 5, active: true, hot: false, note: '' },
      { id: 'lifetime', label: 'Vĩnh viễn', price: 1000000, durationHours: 87600, deviceLimit: 5, active: true, hot: false, note: 'Key tĩnh' }
    ];
  }
  const ids = new Set();
  for (const plan of plans) { if (ids.has(plan.id)) throw new Error('Mã gói bị trùng: ' + plan.id); ids.add(plan.id); }
  const theme = v.theme && typeof v.theme === 'object' ? v.theme : {};
  return {
    telegramUsername: String(v.telegramUsername || '').trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64),
    groupTaskText: String(v.groupTaskText || '').slice(0, 2000),
    groupPromoText: String(v.groupPromoText || '').slice(0, 500),
    groupTaskPhotos: Math.min(10, Math.max(1, Number(v.groupTaskPhotos) || 3)),
    groupTaskTimeoutSec: Math.min(3600, Math.max(60, Number(v.groupTaskTimeoutSec) || 300)),
    supportUrl: String(v.supportUrl || 'https://t.me/SunNetWin').trim().slice(0, 200),
    watermarkText: String(v.watermarkText || 'ToolTungTung · SunWin · MD5 · HitClub').trim().slice(0, 300),
    siteTitle: String(v.siteTitle || 'ToolTungTung').trim().slice(0, 80),
    announceText: String(v.announceText || '').slice(0, 1000),
    welcomeText: String(v.welcomeText || 'Chào mừng đến ToolTungTung').slice(0, 500),
    shopNote: String(v.shopNote || 'Chọn gói · thanh toán qua bot Telegram').slice(0, 500),
    trialNote: String(v.trialNote || 'Nhắn bot để nhận key dùng thử').slice(0, 300),
    disclaimer: String(v.disclaimer || 'Dự đoán chỉ mang tính tham khảo, không đảm bảo thắng.').slice(0, 400),
    minConfidenceShow: Math.min(100, Math.max(0, Number(v.minConfidenceShow ?? 0))),
    defaultDeviceLimit: Math.max(1, Math.min(20, Number(v.defaultDeviceLimit || 3))),
    allowRegisterHint: v.allowRegisterHint !== false,
    theme: {
      primary: String(theme.primary || '#35e7ff').slice(0, 20),
      secondary: String(theme.secondary || '#8a6bff').slice(0, 20),
      accent: String(theme.accent || '#ff56c9').slice(0, 20)
    },
    maintenance: {
      enabled: !!(v.maintenance && v.maintenance.enabled),
      message: String((v.maintenance && v.maintenance.message) || 'Hệ thống đang bảo trì, vui lòng quay lại sau.').slice(0, 500),
      lockedGames: Array.isArray(v.maintenance && v.maintenance.lockedGames)
        ? v.maintenance.lockedGames.map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 50)
        : [],
      lockedCommands: Array.isArray(v.maintenance && v.maintenance.lockedCommands)
        ? v.maintenance.lockedCommands.map(x => String(x).trim().toLowerCase().replace(/^\//, '')).filter(Boolean).slice(0, 50)
        : []
    },
    bankCode: String(v.bankCode || '').trim().slice(0, 40),
    bankAccount: String(v.bankAccount || '').trim().slice(0, 40),
    bankAccountName: String(v.bankAccountName || '').trim().slice(0, 120),
    plans,
    orderTimeoutSec: Math.min(900, Math.max(60, Number(v.orderTimeoutSec || 300))),
    // ===== GETKEYV2 / Index Key configurable =====
    getkeyv2MaxPerDay: Math.min(20, Math.max(1, Number(v.getkeyv2MaxPerDay ?? 2))),
    getkeyv2LinkMinutes: Math.min(30, Math.max(1, Number(v.getkeyv2LinkMinutes ?? 5))),
    getkeyv2KeyHours: Math.min(168, Math.max(0.25, Number(v.getkeyv2KeyHours ?? 18))),
    indexKeyMinutes: Math.min(180, Math.max(5, Number(v.indexKeyMinutes ?? 30))),
    link4mBaseUrl: String(v.link4mBaseUrl || 'https://link4m.co/api-shorten/v2').trim().slice(0, 200),
    link4mApiToken: String(v.link4mApiToken || '').trim().slice(0, 120),
    telegramBotUrl: String(v.telegramBotUrl || '').trim().slice(0, 200),
    feedbackChannelId: String(v.feedbackChannelId || '').trim().slice(0, 100),
    spamCmdLimit: Math.min(20, Math.max(3, Number(v.spamCmdLimit ?? 5))),
    spamWindowSec: Math.min(60, Math.max(5, Number(v.spamWindowSec ?? 10))),
    spamLockSec: Math.min(300, Math.max(10, Number(v.spamLockSec ?? 30))),
    predictionCalibrationEnabled: v.predictionCalibrationEnabled !== false,
    predictionConfidenceCap: Math.min(85, Math.max(50, Number(v.predictionConfidenceCap ?? 68))),
    predictionMinSamples: Math.min(100, Math.max(5, Number(v.predictionMinSamples ?? 12))),
    botWelcome: String(v.botWelcome || 'Chào {name}! ToolTungTung hỗ trợ mua key VIP.').slice(0, 500),
    botPayExpireText: String(v.botPayExpireText || 'Số tiền key thời gian tạo đã hết hạn. Vui lòng tạo mới nếu mua hàng.').slice(0, 400),
    showComingSoon: v.showComingSoon !== false,
    qrPrefix: String(v.qrPrefix || 'TungTung').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'TungTung'
  };
}
function saveBotSettings() { saveJSON(SETTINGS_FILE, botSettings); }
try { botSettings = normalizeSettings(botSettings); } catch (e) { logLine('settings normalization warning: ' + e.message); }
let botRequests = loadJSON(REQUESTS_FILE, []);
if (!Array.isArray(botRequests)) botRequests = [];
let botSessions = loadJSON(BOT_SESSIONS_FILE, {});
if (!botSessions || typeof botSessions !== 'object') botSessions = {};
function saveRequests() { saveJSON(REQUESTS_FILE, botRequests); }
let userProfiles = loadJSON(typeof USERS_FILE !== 'undefined' ? USERS_FILE : path.join(DATA_DIR, 'user_profiles.json'), {});
if (!userProfiles || typeof userProfiles !== 'object') userProfiles = {};
function saveUserProfiles() {
  try { saveJSON(typeof USERS_FILE !== 'undefined' ? USERS_FILE : path.join(DATA_DIR, 'user_profiles.json'), userProfiles); } catch (e) {}
}
function touchUserProfile(id, patch) {
  const tid = String(id || '').trim();
  if (!tid) return null;
  const cur = userProfiles[tid] || { telegramId: tid, firstSeen: Date.now() };
  Object.assign(cur, patch || {});
  cur.telegramId = tid;
  cur.lastSeen = Date.now();
  cur.seenCount = Number(cur.seenCount || 0) + 1;
  userProfiles[tid] = cur;
  saveUserProfiles();
  return cur;
}
function formatUserProfile(p, extra) {
  if (!p) return '❌ Chưa có hồ sơ user';
  const lines = [
    '👤 <b>HỒ SƠ USER</b>',
    '━━━━━━━━━━━━━━━',
    '🆔 TG ID: <code>' + (p.telegramId || '—') + '</code>',
    '🏷 Tên: ' + (p.name || '—'),
    '🔗 Username: @' + (p.username || '—'),
    '🌐 Language: ' + (p.languageCode || '—'),
    '🤖 Is bot: ' + (p.isBot ? 'yes' : 'no'),
    '⭐ Premium TG: ' + (p.isPremium ? 'yes' : 'no'),
    '📅 First: ' + (p.firstSeen ? new Date(p.firstSeen).toLocaleString('vi-VN') : '—'),
    '👁 Last: ' + (p.lastSeen ? new Date(p.lastSeen).toLocaleString('vi-VN') : '—'),
    '🔢 Seen: ' + (p.seenCount || 0),
    '📡 IP (Mini App): <code>' + (p.lastIp || '—') + '</code>',
    '🖥 UA: <code>' + String(p.lastUa || '—').slice(0, 120) + '</code>',
    '📱 DeviceId hash: <code>' + String(p.lastDeviceHash || '—').slice(0, 16) + '</code>',
    '🔑 Key login: ' + (p.lastKeyLabel || '—'),
    '🎮 Last game: ' + (p.lastGame || '—'),
  ];
  if (extra) lines.push(extra);
  return lines.join('\n');
}

function getSessions() { return botSessions; }
function saveSessions(next) { botSessions = next || {}; saveJSON(BOT_SESSIONS_FILE, botSessions); }
function addRequest(request) { botRequests.unshift(request); botRequests = botRequests.slice(0, 5000); saveRequests(); }
function publicRequest(r) {
  return { id: r.id, type: r.type, status: r.status, telegramId: r.telegramId, username: r.username, userName: r.userName,
    groupLink: r.groupLink || '', caption: r.caption || '', planId: r.planId || null, planLabel: r.planLabel || '',
    price: r.price || 0, durationHours: r.durationHours || 5, createdAt: r.createdAt, reviewedAt: r.reviewedAt || null,
    reviewer: r.reviewer || null, deliveredAt: r.deliveredAt || null, proofAttached: !!(r.proofFileId || (r.proofFileIds && r.proofFileIds.length)), proofCount: (r.proofFileIds && r.proofFileIds.length) || (r.proofFileId ? 1 : 0) };
}
function markDelivered(id) {
  const request = botRequests.find(r => r.id === id);
  if (request) { delete request.issuedKey; request.deliveredAt = Date.now(); saveRequests(); }
}
function reviewRequest(id, approved, reviewer) {
  const request = botRequests.find(r => r.id === id);
  if (!request) return { ok: false, error: 'Không tìm thấy yêu cầu.' };
  if (request.status !== 'pending') return { ok: false, error: 'Yêu cầu này đã được xử lý.' };
  request.status = approved ? 'approved' : 'rejected'; request.reviewedAt = Date.now(); request.reviewer = String(reviewer || 'admin');
  let issued = null;
  if (approved && request.type === 'reset') {
    const k = findKey(request.resetKeyPlain || '') || keys.find(x => x.id === request.resetKeyId);
    if (k) { k.deviceHashes = []; saveKeys(); }
  } else if (approved && request.type === 'feedback') {
    // Feedback only gets published after review; never issue a key for this request.
    request.published = false;
  } else if (approved) {
    const isTrial = request.type === 'trial';
    const hours = isTrial ? 0.25 : Math.max(1, Number(request.durationHours || 5));
    issued = createKey({ label: `${request.planLabel || 'Key free'} · TG ${request.telegramId}`, durationHours: hours, deviceLimit: isTrial ? 1 : Math.max(1, Number(request.deviceLimit || 3)),
      source: isTrial ? 'telegram-task-trial' : (request.type === 'payment' ? 'telegram-payment' : 'telegram-group'), telegramId: request.telegramId });
    request.issuedKey = issued.plainKey;
    request.issuedKeyExpiresAt = issued.record.expiresAt;
    request.durationHours = hours;
    if (isTrial && typeof trialUses !== 'undefined') {
      trialUses[String(request.telegramId)] = { day: bangkokDayKey(), status: 'approved', requestId: request.id, keyId: issued.record.id, issuedAt: Date.now(), expiresAt: issued.record.expiresAt };
      try { saveJSON(TRIAL_FILE, trialUses); } catch (_) {}
    }
  }
  if (!approved && request.type === 'trial' && typeof trialUses !== 'undefined') {
    const tr = trialUses[String(request.telegramId)];
    if (tr && tr.requestId === request.id) { tr.status = 'rejected'; tr.reviewedAt = Date.now(); try { saveJSON(TRIAL_FILE, trialUses); } catch (_) {} }
  }
  saveRequests();
  return { ok: true, request, key: issued?.plainKey || null, meta: issued ? { label: issued.record.label, durationHours: request.durationHours, expiresAt: issued.record.expiresAt } : null };
}

// ---------- public endpoints ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now(), games: Object.keys(FEEDS) }));

// ===== Link4M: user vượt xong bị redirect về đây → biết chắc đã vượt =====
app.get('/api/link4m/pass', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  const code = String(req.query.c || req.query.code || '').trim();
  const uidQ = String(req.query.u || req.query.uid || '').trim();

  const page = (opts) => {
    const { title, ok, key, minutes, hours, err } = opts;
    const keyBlock = key ? `
      <div class="keybox" id="keybox">${String(key).replace(/</g,'&lt;')}</div>
      <button type="button" class="btn" id="btnCopy">📋 Sao chép Key</button>
      <p class="tiny" id="copied" hidden>Đã sao chép!</p>
      <p class="hint">Hết hạn khoảng <b>${hours != null ? hours + ' giờ' : (minutes || 30) + ' phút'}</b> · Dùng 1 thiết bị</p>
      <a class="link" href="/">Mở trang Index để UNLOCK →</a>
      <script>
        (function(){
          var k=${JSON.stringify(String(key))};
          var btn=document.getElementById('btnCopy');
          var ok=document.getElementById('copied');
          btn.addEventListener('click',function(){
            if(navigator.clipboard&&navigator.clipboard.writeText){
              navigator.clipboard.writeText(k).then(function(){ok.hidden=false;btn.textContent='✅ Đã sao chép';}).catch(fallback);
            } else fallback();
            function fallback(){
              var t=document.createElement('textarea');t.value=k;document.body.appendChild(t);t.select();
              try{document.execCommand('copy');ok.hidden=false;btn.textContent='✅ Đã sao chép';}catch(e){}
              document.body.removeChild(t);
            }
          });
        })();
      </script>` : (err ? `<p class="err">${err}</p>` : '');
    return `<!doctype html><html lang="vi"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title || 'Nhận Key'} · ToolTungTung</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
  font-family:"Be Vietnam Pro",system-ui,-apple-system,sans-serif;background:#f1f5f9;color:#0f172a}
.card{width:100%;max-width:420px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px 22px;text-align:center;
  box-shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.06)}
.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700;
  background:${ok ? '#f0fdf4' : '#fef2f2'};color:${ok ? '#16a34a' : '#dc2626'};margin-bottom:12px}
h1{font-size:20px;margin:0 0 8px;font-weight:700}
.sub{color:#64748b;font-size:14px;margin:0 0 18px;line-height:1.5}
.keybox{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;font-weight:600;word-break:break-all;
  background:#0f172a;color:#e2e8f0;padding:14px 12px;border-radius:12px;margin:0 0 14px;user-select:all}
.btn{width:100%;border:none;border-radius:12px;padding:14px 16px;font-size:15px;font-weight:700;cursor:pointer;
  background:#2563eb;color:#fff}
.btn:active{transform:scale(.98)}
.tiny{color:#16a34a;font-size:13px;font-weight:600;margin:10px 0 0}
.hint{color:#64748b;font-size:13px;margin:14px 0 0}
.link{display:inline-block;margin-top:16px;color:#2563eb;font-weight:600;font-size:14px;text-decoration:none}
.err{color:#dc2626;font-size:14px}
.foot{margin-top:18px;font-size:12px;color:#94a3b8}
</style></head>
<body><div class="card">
  <div class="badge">${ok ? '✓ Vượt thành công' : 'Không hợp lệ'}</div>
  <h1>${title || ''}</h1>
  <p class="sub">${ok ? 'Sao chép key → quay lại Telegram gõ <b>/nhapkey KEY</b> hoặc mở Index dán key.' : ''}</p>
  ${keyBlock}
  <div class="foot">ToolTungTung · @SunNetWin</div>
</div></body></html>`;
  };

  if (!code) {
    return res.status(400).type('html').send(page({ title: 'Link không hợp lệ', ok: false, err: 'Thiếu mã xác nhận.' }));
  }
  let pending = pendingLink4mByCode[code] || null;
  if (!pending && uidQ && pendingLink4m[uidQ] && pendingLink4m[uidQ].trackCode === code) {
    pending = pendingLink4m[uidQ];
  }
  if (!pending) {
    return res.status(404).type('html').send(page({
      title: 'Link hết hạn hoặc không tồn tại',
      ok: false,
      err: 'Gõ /getkeyv2 trên bot để lấy link mới.'
    }));
  }
  if (uidQ && String(pending.fromId) !== uidQ) {
    return res.status(403).type('html').send(page({ title: 'Không khớp người dùng', ok: false, err: 'Mã xác nhận không khớp Telegram ID. Hãy mở link trực tiếp do bot gửi.' }));
  }
  if (pending.expiresAt && pending.expiresAt < Date.now()) {
    try { delete pendingLink4mByCode[code]; } catch (e) {}
    return res.status(410).type('html').send(page({
      title: 'Link đã hết hạn',
      ok: false,
      err: 'Gõ /getkeyv2 trên bot để tạo link mới.'
    }));
  }

  pending.verified = true;
  pending.verifiedAt = pending.verifiedAt || Date.now();
  const uid = String(pending.fromId || uidQ || '');
  // Đồng bộ phiên lưu trên bot để /done không coi link đã vượt là chưa xác minh.
  try {
    const activeSessions = getSessions();
    if (activeSessions[uid] && activeSessions[uid].type === 'getkeyv2' && activeSessions[uid].trackCode === code) {
      activeSessions[uid].verified = true;
      activeSessions[uid].verifiedAt = pending.verifiedAt;
      saveSessions(activeSessions);
    }
  } catch (_) {}

  const cfg = (typeof botSettings !== 'undefined' && botSettings) ? botSettings : {};
  const keyTtlHours = Number(cfg.getkeyv2KeyHours) || 18;
  const maxPerDay = Number(cfg.getkeyv2MaxPerDay) || 2;

  // Phát key một lần — lưu trên pending để F5 vẫn xem lại được trong phiên
  if (!pending.plainKey) {
    const day = bangkokDayKey();
    let rec = getkeyv2Uses[uid];
    if (!rec || rec.day !== day) {
      rec = { day, count: 0 };
      getkeyv2Uses[uid] = rec;
    }
    if (rec.count >= maxPerDay) {
      return res.type('html').send(page({
        title: 'Hết lượt hôm nay',
        ok: false,
        err: 'Bạn đã vượt đủ ' + maxPerDay + ' lần. Quay lại ngày mai hoặc mua key /muakeytx.'
      }));
    }
    try {
      const issued = createKey({
        label: 'Index Key · ' + keyTtlHours + 'h · TG ' + uid,
        durationHours: keyTtlHours,
        deviceLimit: 1,
        source: 'getkeyv2-page',
        telegramId: uid || null
      });
      pending.plainKey = issued.plainKey;
      pending.keySent = true;
      rec.count += 1;
      saveGetkeyv2Uses();
      // Giữ phiên pending tới hết TTL để F5 trang này vẫn trả đúng cùng key.
      // Timer gốc sẽ dọn phiên và không nhắn hết hạn nếu đã verified/keySent.
    } catch (e) {
      return res.status(500).type('html').send(page({
        title: 'Lỗi tạo key',
        ok: false,
        err: (e && e.message) || 'Thử lại sau.'
      }));
    }
    // Báo Telegram (không phát key lần 2 — chỉ thông báo)
    try {
      if (pending.chatId && typeof tgSendMessage === 'function') {
        const appUrl = getPublicBase() ? (getPublicBase() + '/') : '/';
        await tgSendMessage(pending.chatId,
          '✅ <b>Vượt thành công</b>\n🔑 Key đã hiện trên trang web.\nHoặc copy dòng dưới:\n<code>' +
          String(pending.plainKey).replace(/&/g,'&amp;').replace(/</g,'&lt;') +
          '</code>\n\n🎮 Mở Index dán key để UNLOCK.',
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
            [{ text: '📋 Sao chép Key', copy_text: { text: String(pending.plainKey) } }],
            [{ text: '🎮 Mở Index', web_app: { url: appUrl } }]
          ] } }
        );
      }
    } catch (e) {
      try { logLine('link4m tg notify fail: ' + (e.message || e)); } catch (_) {}
    }
  }

  return res.type('html').send(page({
    title: 'Key của bạn',
    ok: true,
    key: pending.plainKey,
    hours: keyTtlHours
  }));
});

// ---------- Telegram Mini App helpers ----------
function getPublicBase() {
  let s = String(process.env.PUBLIC_URL || process.env.WEB_URL || '').trim();
  if (!s) return '';
  s = s.replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase();
    if (['localhost','127.0.0.1','::1'].includes(h) || h.endsWith('.local')) return '';
    return u.origin.replace(/\/+$/, '');
  } catch (_) { return ''; }
}
function isTelegramAdmin(tgId) {
  const ids = String(process.env.TELEGRAM_ADMIN_IDS || process.env.ADMIN_IDS || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  return ids.includes(String(tgId));
}
async function answerTelegram(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.WEB_BOT_TOKEN;
  if (!token) throw new Error('no bot token');
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.warn('[tg]', method, j.description || j);
  return j;
}

app.get('/api/public/miniapp', (req, res) => {
  const base = getPublicBase() || (req.protocol + '://' + req.get('host'));
  res.json({
    userUrl: base + '/',
    adminUrl: null, // dùng bot /helpadmin
    brand: 'ToolTungTung',
    support: '@SunNetWin'
  });
});

// Mini App: xác thực sơ bộ bằng initDataUnsafe user id (production nên verify hash HMAC)
app.post('/api/auth/telegram-webapp', express.json(), (req, res) => {
  const user = req.body?.user || {};
  const tgId = user.id || user.user_id;
  if (!tgId) return res.status(400).json({ error: 'Thiếu Telegram user' });
  const admin = isTelegramAdmin(tgId);
  const base = getPublicBase() || (req.protocol + '://' + req.get('host'));
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  try {
    touchUserProfile(tgId, {
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || '',
      username: user.username || '',
      languageCode: user.language_code || user.languageCode || '',
      isPremium: !!(user.is_premium || user.isPremium),
      isBot: !!user.is_bot,
      lastIp: ip || undefined,
      lastUa: ua || undefined,
      lastSource: 'miniapp'
    });
  } catch (e) {}
  res.json({
    ok: true,
    telegramId: tgId,
    isAdmin: admin,
    ip,
    openUrl: (base + '/'),
    role: admin ? 'admin' : 'user'
  });
});


app.get('/api/public/config', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  // Game-link normalization: one valid playUrl is shared by every variant with the same brand.
  // This prevents a stale comingSoon flag on TX/Sicbo/MD5 siblings from locking the whole card.
  const allGames = Array.isArray(gameConfigs) ? gameConfigs : [];
  const normBrand = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'game';
  const brandPlay = Object.create(null);
  for (const g of allGames) {
    const candidate = String(g.playUrl || g.play_url || g.gameLink || '').trim();
    if (candidate && validHttpUrl(candidate)) {
      const b = normBrand(g.brand || g.id);
      if (!brandPlay[b]) brandPlay[b] = { url: candidate, mode: g.playMode === 'external' ? 'external' : 'embed' };
    }
  }
  const games = allGames.filter(g => g.visible !== false).map(g => {
    const b = normBrand(g.brand || g.id);
    const ownPlay = String(g.playUrl || g.play_url || g.gameLink || '').trim();
    const shared = brandPlay[b];
    const effectivePlayUrl = ownPlay && validHttpUrl(ownPlay) ? ownPlay : (shared ? shared.url : '');
    return {
      id: g.id, label: g.label || g.id, group: g.group || 'tx', brand: g.brand || g.id,
      brandLabel: g.brandLabel || g.label || g.id, variant: g.variant || '', playUrl: effectivePlayUrl,
      historyUrl: g.historyUrl || '', table: g.table || '', url: g.url || '',
      playMode: g.playMode === 'external' ? 'external' : (shared ? shared.mode : 'embed'), enabled: g.enabled !== false,
      visible: g.visible !== false, comingSoon: !!g.comingSoon && !effectivePlayUrl,
      icon: g.icon || '', iconUrl: g.iconUrl || '', parser: g.parser || 'lc79'
    };
  });
  const wm = botSettings.watermarkText || (games.length ? games.map(x => x.label).join(' · ') + ' · ToolTungTung' : 'ToolTungTung');
  const tgUser = String(botSettings.telegramUsername || process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
  const plans = (botSettings.plans || []).filter(p => p.active !== false).map(p => ({
    id: p.id, label: p.label, price: Number(p.price), durationHours: Number(p.durationHours),
    deviceLimit: Number(p.deviceLimit || 3), hot: !!p.hot, note: String(p.note || '')
  }));
  res.json({
    ok: true,
    brand: BRAND,
    siteTitle: botSettings.siteTitle || 'ToolTungTung',
    telegramUsername: tgUser,
    telegramBotUrl: (String(botSettings.telegramBotUrl || '').trim() || (String(process.env.TELEGRAM_BOT_USERNAME || botSettings.telegramUsername || '').trim() ? ('https://t.me/' + String(process.env.TELEGRAM_BOT_USERNAME || botSettings.telegramUsername).trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '')) : '')),
    telegramUrl: tgUser ? ('https://t.me/' + tgUser) : (botSettings.supportUrl || 'https://t.me/SunNetWin'),
    supportUrl: botSettings.supportUrl || (tgUser ? ('https://t.me/' + tgUser) : 'https://t.me/SunNetWin'),
    watermarkText: wm,
    games,
    maintenance: {
      enabled: !!(botSettings.maintenance && botSettings.maintenance.enabled),
      message: (botSettings.maintenance && botSettings.maintenance.message) || '',
      lockedGames: (botSettings.maintenance && botSettings.maintenance.lockedGames) || []
    },
    plans,
    welcomeText: botSettings.welcomeText || '',
    shopNote: botSettings.shopNote || '',
    trialNote: botSettings.trialNote || '',
    disclaimer: botSettings.disclaimer || '',
    theme: botSettings.theme || null,
    announceText: botSettings.announceText || ''
  });
});
app.post('/api/auth', (req, res) => {
  if (!rateLimit(req.ip)) return res.status(429).json({ error: 'Bạn thử quá nhiều lần. Vui lòng đợi 1 phút.' });
  const plain = String(req.body?.key || '').trim();
  if (!plain) return res.status(400).json({ error: 'Vui lòng nhập key VIP.' });
  const deviceId = String(req.body?.deviceId || '').trim();
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const deviceHash = sha256(deviceId || (ua + '|' + ip));

  // ===== Index Key (getkeyv2) — chấp nhận IDX-... =====
  const upper = plain.toUpperCase();
  if (upper.startsWith('IDX-') && indexKeys[upper]) {
    const rec = indexKeys[upper];
    if (rec.used) return res.status(401).json({ error: 'Index Key đã được sử dụng trên thiết bị khác.' });
    if (rec.expiresAt && rec.expiresAt <= Date.now()) {
      delete indexKeys[upper];
      saveIndexKeys();
      return res.status(401).json({ error: 'Index Key đã hết hạn. Gõ /getkeyv2 để lấy key mới.' });
    }
    // Bind 1 device
    if (!rec.deviceHash) {
      rec.deviceHash = deviceHash;
      rec.used = true;
      saveIndexKeys();
    } else if (rec.deviceHash !== deviceHash) {
      return res.status(401).json({ error: 'Index Key chỉ dùng được trên 1 thiết bị.' });
    }
    // Issue short-lived real key in keys[] so requireUser works
    let realKey;
    try {
      realKey = createKey({
        label: 'Index Key · 30p · TG ' + (rec.telegramId || ''),
        durationHours: Math.max(0.1, ((rec.expiresAt || (Date.now() + 30 * 60000)) - Date.now()) / 3600000),
        deviceLimit: 1,
        source: 'index-key-v2',
        telegramId: rec.telegramId || null
      });
    } catch (e) {
      return res.status(500).json({ error: 'Không tạo được phiên: ' + (e.message || 'lỗi') });
    }
    const found = realKey.record;
    const exp = found.expiresAt ? Math.min(Date.now() + USER_TOKEN_TTL_MS, found.expiresAt) : Date.now() + USER_TOKEN_TTL_MS;
    const token = sign({ type: 'user', keyId: found.id, deviceHash, exp });
    logLine(`index-key auth ok: ${upper.slice(0, 12)}... tg=${rec.telegramId} ip=${ip}`);
    return res.json({
      ok: true,
      token,
      expiresIn: exp - Date.now(),
      label: found.label,
      expiresAt: found.expiresAt || null,
      expires_at: found.expiresAt || null,
      deviceLimit: 1,
      devicesUsed: 1,
      keyExpiresAt: found.expiresAt || null,
      expireSoon: true,
      remainMs: found.expiresAt ? Math.max(0, found.expiresAt - Date.now()) : null
    });
  }

  const found = findKey(plain);
  if (!found || found.status === 'revoked') return res.status(401).json({ error: 'Key không hợp lệ hoặc đã bị thu hồi.' });
  if (isExpired(found)) return res.status(401).json({ error: 'Key đã hết hạn. Hãy nhận hoặc mua key mới trên Telegram.' });
  const deviceBinding = bindKeyDevice(found, deviceHash);
  if (!deviceBinding.ok) return res.status(403).json({ error: deviceBinding.error });
  found.lastUsed = Date.now();
  found.uses = Number(found.uses || 0) + 1;
  found.lastIp = ip || found.lastIp;
  saveKeys();
  const requestedExpiry = Date.now() + USER_TOKEN_TTL_MS;
  const exp = found.expiresAt ? Math.min(requestedExpiry, found.expiresAt) : requestedExpiry;
  const token = sign({ type: 'user', keyId: found.id, deviceHash, exp });
  try {
    if (found.telegramId) {
      touchUserProfile(found.telegramId, {
        lastIp: ip, lastUa: ua, lastDeviceHash: deviceHash, lastKeyLabel: found.label,
        lastSource: 'key-login'
      });
    }
  } catch (e) {}
  logLine(`user auth ok: ${found.label} device=${deviceHash.slice(0, 8)} ip=${ip}`);
  res.json({
    ok: true,
    token,
    expiresIn: exp - Date.now(),
    label: found.label,
    expiresAt: found.expiresAt || null,
    expires_at: found.expiresAt || null,
    deviceLimit: Math.max(1, Number(found.deviceLimit || 1)),
    devicesUsed: (found.deviceHashes || []).length,
    keyExpiresAt: found.expiresAt || null,
    expireSoon: found.expiresAt ? (found.expiresAt - Date.now() < 24 * 3600000) : false,
    remainMs: found.expiresAt ? Math.max(0, found.expiresAt - Date.now()) : null
  });
});

// Tương thích UI gốc gọi /api/activate (hỗ trợ Index Key + key thường)
app.post('/api/activate', (req, res) => {
  if (req.body && req.body.device_id && !req.body.deviceId) req.body.deviceId = req.body.device_id;
  if (!rateLimit(req.ip)) return res.status(429).json({ error: 'Bạn thử quá nhiều lần. Vui lòng đợi 1 phút.', ok: false });
  const plain = String(req.body?.key || '').trim();
  if (!plain) return res.status(400).json({ error: 'Vui lòng nhập key VIP.', ok: false });
  const deviceId = String(req.body?.deviceId || req.body?.device_id || '').trim();
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const deviceHash = sha256(deviceId || (ua + '|' + ip));

  const upper = plain.toUpperCase();
  if (upper.startsWith('IDX-') && indexKeys[upper]) {
    const rec = indexKeys[upper];
    if (rec.used) return res.status(401).json({ error: 'Index Key đã được sử dụng.', ok: false });
    if (rec.expiresAt && rec.expiresAt <= Date.now()) {
      delete indexKeys[upper]; saveIndexKeys();
      return res.status(401).json({ error: 'Index Key đã hết hạn.', ok: false });
    }
    if (!rec.deviceHash) { rec.deviceHash = deviceHash; rec.used = true; saveIndexKeys(); }
    else if (rec.deviceHash !== deviceHash) return res.status(401).json({ error: 'Index Key chỉ dùng 1 thiết bị.', ok: false });
    let realKey;
    try {
      realKey = createKey({
        label: 'Index Key · 30p · TG ' + (rec.telegramId || ''),
        durationHours: Math.max(0.1, ((rec.expiresAt || Date.now() + 30 * 60000) - Date.now()) / 3600000),
        deviceLimit: 1, source: 'index-key-v2', telegramId: rec.telegramId || null
      });
    } catch (e) { return res.status(500).json({ error: e.message || 'lỗi', ok: false }); }
    const found = realKey.record;
    const exp = found.expiresAt ? Math.min(Date.now() + USER_TOKEN_TTL_MS, found.expiresAt) : Date.now() + USER_TOKEN_TTL_MS;
    const token = sign({ type: 'user', keyId: found.id, deviceHash, exp });
    return res.json({
      ok: true, token, expiresIn: exp - Date.now(),
      expires_at: found.expiresAt || null, expiresAt: found.expiresAt || null,
      label: found.label, deviceLimit: 1, devicesUsed: 1,
      keyExpiresAt: found.expiresAt || null, expireSoon: true,
      remainMs: found.expiresAt ? Math.max(0, found.expiresAt - Date.now()) : null
    });
  }

  const found = findKey(plain);
  if (!found || found.status === 'revoked') return res.status(401).json({ error: 'Key không hợp lệ hoặc đã bị thu hồi.', ok: false });
  if (isExpired(found)) return res.status(401).json({ error: 'Key đã hết hạn. Hãy nhận hoặc mua key mới trên Telegram.', ok: false });
  const deviceBinding = bindKeyDevice(found, deviceHash);
  if (!deviceBinding.ok) return res.status(403).json({ error: deviceBinding.error, ok: false });
  found.lastUsed = Date.now();
  found.uses = Number(found.uses || 0) + 1;
  found.lastIp = ip || found.lastIp;
  saveKeys();
  const requestedExpiry = Date.now() + USER_TOKEN_TTL_MS;
  const exp = found.expiresAt ? Math.min(requestedExpiry, found.expiresAt) : requestedExpiry;
  const token = sign({ type: 'user', keyId: found.id, deviceHash, exp });
  logLine(`activate ${found.label || found.id} ip=${ip} ua=${ua.slice(0,40)}`);
  res.json({
    ok: true, token, expiresIn: exp - Date.now(),
    expires_at: found.expiresAt || null, expiresAt: found.expiresAt || null,
    label: found.label, deviceLimit: Math.max(1, Number(found.deviceLimit || 1)), devicesUsed: (found.deviceHashes || []).length,
    keyExpiresAt: found.expiresAt || null,
    expireSoon: found.expiresAt ? (found.expiresAt - Date.now() < 24 * 3600000) : false,
    remainMs: found.expiresAt ? Math.max(0, found.expiresAt - Date.now()) : null
  });
});

app.post('/api/admin/login', (req, res) => {
  if (!rateLimit(req.ip)) return res.status(429).json({ error: 'Bạn thử quá nhiều lần. Vui lòng đợi 1 phút.' });
  if (!ADMIN_PASSWORDS.length) return res.status(503).json({ error: 'Chưa cấu hình ADMIN_PASSWORD trên Railway Variables.' });
  const password = String(req.body?.password || '').trim();
  if (!ADMIN_PASSWORDS.some(candidate => secureEqual(password, candidate))) return res.status(401).json({ error: 'Mật khẩu admin không đúng.' });
  const token = sign({ type: 'admin', exp: Date.now() + TOKEN_TTL_MS });
  logLine('admin login ok');
  res.json({ token, expiresIn: TOKEN_TTL_MS });
});

// ---------- user prediction endpoints ----------




// Trial registry is shared by Telegram task flow and survives normal process restarts when DATA_DIR is persistent.
const TRIAL_FILE = path.join(DATA_DIR, 'telegram_trial_uses.json');
let trialUses = loadJSON(TRIAL_FILE, {});
if (!trialUses || typeof trialUses !== 'object' || Array.isArray(trialUses)) trialUses = {};

// Trial issuance must pass through the Telegram bot task (/getkeyv1); do not mint a free key from a direct HTTP request.
app.post('/api/trial/telegram', (req, res) => res.status(403).json({ ok: false, error: 'Key dùng thử chỉ được cấp sau khi hoàn thành nhiệm vụ trong Telegram bot. Gõ /getkeyv1.' }));

// Validate Index Key from Mini App (one-time, 30 min)
app.post('/api/index-key/validate', (req, res) => {
  const key = String(req.body?.key || req.query?.key || '').trim().toUpperCase();
  const deviceHash = String(req.body?.device || req.headers['x-device-hash'] || '').slice(0, 64);
  if (!key || !indexKeys[key]) return res.status(401).json({ ok: false, error: 'Key không hợp lệ hoặc đã hết hạn.' });
  const rec = indexKeys[key];
  if (rec.used) return res.status(401).json({ ok: false, error: 'Key đã được sử dụng.' });
  if (rec.expiresAt && rec.expiresAt <= Date.now()) {
    delete indexKeys[key];
    saveIndexKeys();
    return res.status(401).json({ ok: false, error: 'Key đã hết hạn.' });
  }
  if (!rec.deviceHash && deviceHash) {
    rec.deviceHash = deviceHash;
    rec.used = true;
    saveIndexKeys();
  } else if (rec.deviceHash && deviceHash && rec.deviceHash !== deviceHash) {
    return res.status(401).json({ ok: false, error: 'Key chỉ dùng được trên 1 thiết bị.' });
  } else {
    rec.used = true;
    saveIndexKeys();
  }
  res.json({ ok: true, expiresAt: rec.expiresAt, label: 'Index Key · 30 phút' });
});

app.get('/api/games', requireUser, (req, res) => {
  const linksByBrand = Object.create(null);
  for (const g of gameConfigs) {
    const b = String(g.brand || g.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const u = String(g.playUrl || '').trim();
    if (u && validHttpUrl(u) && !linksByBrand[b]) linksByBrand[b] = u;
  }
  const games = gameConfigs.filter(g => g.enabled !== false && g.visible !== false && FEEDS[g.id]).map(g => {
    const b = String(g.brand || g.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const playUrl = String(g.playUrl || '').trim() || linksByBrand[b] || '';
    return { id: g.id, label: g.label, gameType: g.group === 'sicbo' ? 'sicbo' : (g.group === 'md5' || /md5/i.test(String(g.variant || '') + ' ' + String(g.id || '')) ? 'md5' : 'tx'), group: g.group || 'tx', icon: g.icon || '', brand: g.brand || g.id, brandLabel: g.brandLabel || g.label, variant: g.variant || '', playUrl, historyUrl: g.historyUrl || '', playMode: g.playMode === 'external' ? 'external' : 'embed', iconUrl: g.iconUrl || '', comingSoon: !!g.comingSoon && !playUrl };
  });
  res.json({ ok: true, games });
});
app.get('/api/me', requireUser, (req, res) => {
  const k = req.userKey;
  res.json({
    label: k.label,
    expiresAt: k.expiresAt || null,
    deviceLimit: k.deviceLimit || 1,
    devicesUsed: Array.isArray(k.deviceHashes) ? k.deviceHashes.length : 0,
    keyId: k.id || null,
    status: k.status || 'active'
  });
});
app.get('/api/predict', requireUser, async (req, res) => {
  const f = FEEDS[req.query.game];
  if (!f || !f.enabled) return res.status(400).json({ error: 'Game không tồn tại hoặc đang tắt.' });
  const mt = botSettings.maintenance || {};
  const gid = String(req.query.game || '').toLowerCase();
  if (mt.enabled && Array.isArray(mt.lockedGames) && mt.lockedGames.map(String).map(s=>s.toLowerCase()).includes(gid)) {
    return res.status(503).json({ error: mt.message || 'Game đang bảo trì.', maintenance: true });
  }
  // Luôn làm mới feed nếu >1.2s (robot index khớp API)
  try {
    if (!f.lastPolledAt || (Date.now() - f.lastPolledAt) > 1200 || req.query.fresh === '1') {
      await pollFeed(String(req.query.game));
    }
  } catch (e) {}
  let ensemble = f.engine.getEnsemblePrediction();
  const cfg = gameConfigs.find(g => g.id === f.id) || {};
  if (cfg.group === 'sicbo' || f.group === 'sicbo') {
    ensemble = enhanceSicbo(f, ensemble);
  }
  f.lastEnsemble = ensemble; // để lần sau anti-repeat vị
  const ms = f.engine.marketState || ensemble.market || {};
  const configuredGameType = (cfg.group === 'sicbo' || f.group === 'sicbo') ? 'sicbo' : (cfg.group === 'md5' || /md5/i.test(String(cfg.variant || '') + ' ' + String(cfg.id || '')) ? 'md5' : 'tx');
  const gameType = configuredGameType || ensemble.gameType || 'tx';
  // Recalibration only reduces overconfident percentages for TX/MD5; prediction and Sunwin Sicbo logic stay unchanged.
  let calibration = null;
  if (configuredGameType !== 'sicbo' && botSettings.predictionCalibrationEnabled !== false && ensemble && Number.isFinite(Number(ensemble.confidence))) {
    const outcomes = (f.accuracyHistory || []).slice(0, 100).filter(row => !row.skipped && (typeof row.isCorrect === 'boolean' || typeof row.hit === 'boolean' || typeof row.correct === 'boolean' || typeof row.ok === 'boolean'));
    const minSamples = Number(botSettings.predictionMinSamples || 12);
    const cap = Number(botSettings.predictionConfidenceCap || 68);
    let raw = Number(ensemble.confidence); if (raw > 0 && raw <= 1) raw *= 100;
    let adjusted = Math.min(raw, cap);
    if (outcomes.length >= minSamples) {
      const hits = outcomes.filter(row => row.isCorrect === true || row.hit === true || row.correct === true || row.ok === true).length;
      const rate = hits / outcomes.length * 100;
      const weight = outcomes.length / (outcomes.length + 30);
      adjusted = 50 + (Math.min(raw, cap) - 50) * 0.65 + (rate - 50) * 0.35 * weight;
      adjusted = Math.max(50, Math.min(cap, adjusted));
      calibration = { samples: outcomes.length, hitRate: +rate.toFixed(1), adjusted: +adjusted.toFixed(1) };
    } else {
      adjusted = Math.max(50, Math.min(60, adjusted));
      calibration = { samples: outcomes.length, hitRate: null, adjusted: +adjusted.toFixed(1) };
    }
    ensemble.confidence = Math.round(adjusted);
  }
  // Tính phiên tiếp theo thật chắc chắn (nhiều nguồn fallback)
  let nextSess = null;
  if (f.openSession != null && f.openSession !== '') {
    nextSess = f.openSession;
  } else if (f.lastLive && f.lastLive.session != null && f.lastLive.session !== '') {
    const n = Number(f.lastLive.session);
    nextSess = Number.isFinite(n) ? n + 1 : f.lastLive.session;
  } else if (f.history && f.history.length) {
    const n = Number(f.history[0].session);
    nextSess = Number.isFinite(n) ? n + 1 : f.history[0].session;
  } else if (f.lastSession != null) {
    const n = Number(f.lastSession);
    nextSess = Number.isFinite(n) ? n + 1 : f.lastSession;
  } else if (f.rawMaxSession != null) {
    nextSess = Number(f.rawMaxSession) + 1;
  }
  // Ép string để frontend luôn hiện được
  if (nextSess != null && nextSess !== '') nextSess = String(nextSess);

  const lastSess = f.lastLive ? f.lastLive.session : (f.history && f.history[0] ? f.history[0].session : (f.lastSession || null));

  res.json({
    game: req.query.game,
    label: f.label,
    gameType,
    predictedResult: ensemble.predictedResult,
    confidence: ensemble.confidence,
    taiProb: ensemble.taiProb,
    xiuProb: ensemble.xiuProb,
    activeModels: ensemble.activeModels || ensemble.modelsUsed,
    topReason: ensemble.topReason || ensemble.reason,
    reason: ensemble.reason || ensemble.topReason,
    regime: ms.regime || null,
    trend: ms.trend || null,
    lastSession: lastSess,
    nextSession: nextSess,
    // aliases cho frontend J() — bắt buộc để hiện PHIÊN
    target_session: nextSess,
    next_session: nextSess,
    phien_tiep: nextSess,
    phien_du_doan: nextSess,
    target: nextSess,
    nextSessionId: nextSess,
    next_session_id: nextSess,
    currentSession: lastSess,
    current_session: lastSess,
    sessionId: lastSess,
    session_id: lastSess,
    session: lastSess,
    phien: lastSess,
    id: lastSess,
    live: f.lastLive || null,
    accuracy: f.total ? { correct: f.correct, total: f.total, pct: +(f.correct / f.total * 100).toFixed(1) } : null,
    feedError: f.lastError || null,
    calibration: calibration,
    algos: ensemble.algos || null,
    sicbo: ensemble.sicbo || null,
    verdict: (Number(ensemble.confidence) || 0) >= 68 ? 'NÊN VÀO' : (Number(ensemble.confidence) || 0) >= 58 ? 'CÂN NHẮC' : 'BỎ QUA'
  });
});
app.get('/api/live', requireUser, (req, res) => {
  const f = FEEDS[req.query.game]; if (!f || !f.enabled) return res.status(400).json({ error: 'Game không tồn tại hoặc đang tắt.' });
  res.json({ live: f.lastLive || null, nextSession: f.lastLive && Number.isFinite(Number(f.lastLive.session)) ? Number(f.lastLive.session) + 1 : null });
});
app.get('/api/history', requireUser, (req, res) => {
  const f = FEEDS[req.query.game]; if (!f || !f.enabled) return res.status(400).json({ error: 'Game không tồn tại hoặc đang tắt.' });
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const accLimit = Math.min(100, Math.max(1, parseInt(req.query.accLimit, 10) || 30));
  res.json({
    game: req.query.game,
    history: f.history.slice(0, limit),
    accuracyHistory: (f.accuracyHistory || []).slice(0, accLimit),
    accuracy: f.total ? { correct: f.correct, total: f.total, pct: +(f.correct / f.total * 100).toFixed(1) } : null
  });
});

app.get('/api/accuracy', requireUser, (req, res) => {
  const f = FEEDS[req.query.game];
  if (!f || !f.enabled) return res.status(400).json({ error: 'Game không hợp lệ.' });
  const limit = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 60));
  const hist = (f.accuracyHistory || []).slice(0, limit);
  const chrono = hist.slice().reverse();
  let runC = 0, runT = 0, hits = 0, miss = 0;
  const series = [];
  for (const row of chrono) {
    const isHit = typeof row.isCorrect === 'boolean' ? row.isCorrect
      : (typeof row.hit === 'boolean' ? row.hit
      : (typeof row.correct === 'boolean' ? row.correct
      : (row.pred != null && row.actual != null ? row.pred === row.actual
      : (row.prediction != null && row.result != null ? row.prediction === row.result : false))));
    if (isHit) hits++; else miss++;
    runT++; if (isHit) runC++;
    series.push({
      session: row.session || row.phien || null,
      hit: !!isHit,
      pred: row.pred || row.prediction || null,
      actual: row.actual || row.result || row.char || null,
      accPct: runT ? +(runC / runT * 100).toFixed(1) : 0
    });
  }
  res.json({
    ok: true,
    game: req.query.game,
    label: f.label,
    correct: f.correct || 0,
    total: f.total || 0,
    accuracy: f.total ? +(f.correct / f.total * 100).toFixed(1) : null,
    hits, miss,
    series
  });
});

app.get('/api/leaderboard', requireUser, (req, res) => {
  const list = [];
  for (const [id, f] of Object.entries(FEEDS)) {
    if (!f || !f.enabled) continue;
    if (String(f.parser || '') === 'tx') continue;
    const total = f.total || 0;
    const correct = f.correct || 0;
    const pct = total ? +(correct / total * 100).toFixed(1) : 0;
    list.push({
      id, label: f.label || id, correct, total, accuracy: pct,
      hot: total >= 8 && pct >= 58
    });
  }
  list.sort((a, b) => (b.accuracy - a.accuracy) || (b.total - a.total));
  res.json({ ok: true, games: list });
});


// ---------- admin: keys, devices, validity ----------
app.get('/api/admin/keys', requireAdmin, (req, res) => res.json({ keys: keys.map(publicKeyInfo).sort((a, b) => b.created - a.created) }));
app.post('/api/admin/keys', requireAdmin, (req, res) => {
  try {
    const result = createKey({ key: req.body?.key || '', label: req.body?.label || 'Key VIP', durationHours: req.body?.durationHours || 0,
      expiresAt: req.body?.expiresAt ?? null, deviceLimit: req.body?.deviceLimit || 3, source: 'admin', static: req.body?.static === true || Number(req.body?.durationHours||0)===0 && (req.body?.expiresAt==null||req.body?.expiresAt==='') });
    res.json({ ok: true, key: result.plainKey, keyInfo: publicKeyInfo(result.record) });
  } catch (e) { res.status(400).json({ error: e.message || 'Không tạo được key.' }); }
});
app.patch('/api/admin/keys/:id', requireAdmin, (req, res) => {
  const key = keys.find(k => k.id === req.params.id);
  if (!key) return res.status(404).json({ error: 'Không tìm thấy key.' });
  try {
    if (req.body?.label !== undefined) key.label = String(req.body.label || 'Key VIP').slice(0, 120);
    if (req.body?.deviceLimit !== undefined) key.deviceLimit = Math.max(1, Math.min(100, Math.floor(Number(req.body.deviceLimit || 1))));
    if (req.body?.durationHours !== undefined) {
      const hours = Math.max(0, Number(req.body.durationHours || 0));
      key.expiresAt = hours > 0 ? Date.now() + hours * 3600000 : null;
    } else if (req.body?.expiresAt !== undefined) {
      if (req.body.expiresAt === null || req.body.expiresAt === '') key.expiresAt = null;
      else {
        const date = typeof req.body.expiresAt === 'number' ? req.body.expiresAt : new Date(req.body.expiresAt).getTime();
        if (!Number.isFinite(date) || date <= Date.now()) throw new Error('Ngày hết hạn phải ở tương lai.');
        key.expiresAt = date;
      }
    }
    if (req.body?.status !== undefined) key.status = req.body.status === 'revoked' ? 'revoked' : 'active';
    saveKeys(); logLine(`key updated: ${key.label}`); res.json({ ok: true, key: publicKeyInfo(key) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/keys/:id/reset-devices', requireAdmin, (req, res) => {
  const key = keys.find(k => k.id === req.params.id);
  if (!key) return res.status(404).json({ error: 'Không tìm thấy key.' });
  // Mặc định KHÔNG reset — mỗi key 1 máy. Chỉ force=true mới cho phép.
  if (req.body?.force !== true) {
    return res.status(403).json({ error: 'Key không được reset thiết bị (1 máy / key). Gửi force:true nếu admin chắc chắn.' });
  }
  key.deviceHashes = [];
  key.lockedIp = null;
  key.boundAt = null;
  saveKeys(); logLine('FORCE reset devices for key ' + key.id); res.json({ ok: true, forced: true });
});
app.delete('/api/admin/keys/:id', requireAdmin, (req, res) => {
  const key = keys.find(k => k.id === req.params.id);
  if (!key) return res.status(404).json({ error: 'Không tìm thấy key.' });
  key.status = 'revoked'; saveKeys(); logLine(`key revoked: ${key.label}`); res.json({ ok: true });
});

// ---------- admin: game API management ----------
app.get('/api/admin/games', requireAdmin, (req, res) => res.json({ games: gameConfigs.map(g => ({ ...g, lastSession: FEEDS[g.id]?.lastSession ?? null, historyCount: FEEDS[g.id]?.history.length || 0, lastError: FEEDS[g.id]?.lastError || null })) }));
app.post('/api/admin/games/reorder', requireAdmin, (req, res) => {
  const requested = Array.isArray(req.body?.ids) ? req.body.ids.map(x => String(x)) : [];
  if (!requested.length || requested.length !== gameConfigs.length || new Set(requested).size !== gameConfigs.length || requested.some(id => !gameConfigs.some(g => g.id === id))) {
    return res.status(400).json({ error: 'Danh sách thứ tự game không hợp lệ.' });
  }
  const byId = new Map(gameConfigs.map(g => [g.id, g]));
  gameConfigs = requested.map(id => byId.get(id));
  saveGameConfigs();
  logLine('game order updated: ' + requested.join(','));
  res.json({ ok: true, ids: requested });
});
app.post('/api/admin/games', requireAdmin, (req, res) => {
  const id = String(req.body?.id || '').trim().toLowerCase();
  const label = String(req.body?.label || '').trim();
  const url = String(req.body?.url || '').trim();
  const parser = ['sunwin','max789','b52hist'].includes(req.body?.parser) ? req.body.parser : 'lc79';
  if (!/^[a-z0-9_-]{2,32}$/.test(id)) return res.status(400).json({ error: 'Mã game chỉ gồm chữ thường, số, _ hoặc - (2–32 ký tự).' });
  if (gameConfigs.some(g => g.id === id)) return res.status(409).json({ error: 'Mã game đã tồn tại.' });
  if (!label) return res.status(400).json({ error: 'Hãy nhập tên game.' });
  if (!validHttpUrl(url)) return res.status(400).json({ error: 'API phải là URL HTTP hoặc HTTPS hợp lệ.' });
  const groupRaw = String(req.body?.group || 'tx').toLowerCase();
  const group = ['tx','sicbo','md5'].includes(groupRaw) ? groupRaw : 'tx';
  const config = {
    id, label: label.slice(0, 80), brand: String(req.body?.brand || id).trim().slice(0, 40),
    brandLabel: String(req.body?.brandLabel || req.body?.brand || label).trim().slice(0, 80),
    url, parser, table: String(req.body?.table || '').slice(0, 80),
    playUrl: String(req.body?.playUrl || '').trim().slice(0, 500),
    historyUrl: String(req.body?.historyUrl || '').trim().slice(0, 500),
    variant: String(req.body?.variant || group.toUpperCase()).trim().slice(0, 40),
    group, icon: String(req.body?.icon || id).trim().slice(0, 40),
    iconUrl: String(req.body?.iconUrl || '').trim().slice(0, 500),
    playMode: req.body?.playMode === 'external' ? 'external' : 'embed',
    enabled: req.body?.enabled !== false, visible: req.body?.visible !== false,
    comingSoon: !!req.body?.comingSoon && !String(req.body?.playUrl || '').trim()
  };
  gameConfigs.push(config); saveGameConfigs(); FEEDS[id] = createFeed(config); logLine(`game added: ${id}`);
  res.json({ ok: true, game: config });
});
app.patch('/api/admin/games/:id', requireAdmin, (req, res) => {
  const config = gameConfigs.find(g => g.id === req.params.id);
  if (!config) return res.status(404).json({ error: 'Không tìm thấy game.' });
  const label = req.body?.label === undefined ? config.label : String(req.body.label || '').trim();
  const url = req.body?.url === undefined ? config.url : String(req.body.url || '').trim();
  if (!label) return res.status(400).json({ error: 'Tên game không được để trống.' });
  if (url && !validHttpUrl(url)) return res.status(400).json({ error: 'API phải là URL HTTP hoặc HTTPS hợp lệ.' });
  config.label = label.slice(0, 80);
  if (url) config.url = url;
  if (req.body?.parser !== undefined) config.parser = ['sunwin','max789','b52hist','lc79'].includes(req.body.parser) ? req.body.parser : 'lc79';
  if (req.body?.table !== undefined) config.table = String(req.body.table || '').slice(0, 80);
  if (req.body?.enabled !== undefined) config.enabled = req.body.enabled !== false;
  if (req.body?.playUrl !== undefined) config.playUrl = String(req.body.playUrl || '').trim().slice(0, 500);
  if (req.body?.playMode !== undefined) config.playMode = req.body.playMode === 'external' ? 'external' : 'embed';
  if (req.body?.brand !== undefined) config.brand = String(req.body.brand || config.id).trim().slice(0, 40);
  if (req.body?.brandLabel !== undefined) config.brandLabel = String(req.body.brandLabel || config.label).trim().slice(0, 80);
  if (req.body?.variant !== undefined) config.variant = String(req.body.variant || '').trim().slice(0, 40);
  if (req.body?.group !== undefined) config.group = ['tx','sicbo','md5'].includes(String(req.body.group).toLowerCase()) ? String(req.body.group).toLowerCase() : (config.group || 'tx');
  if (req.body?.historyUrl !== undefined) config.historyUrl = String(req.body.historyUrl || '').trim().slice(0, 500);
  if (req.body?.icon !== undefined) config.icon = String(req.body.icon || '').trim().slice(0, 40);
  if (req.body?.iconUrl !== undefined) config.iconUrl = String(req.body.iconUrl || '').trim().slice(0, 500);
  if (req.body?.comingSoon !== undefined) config.comingSoon = !!req.body.comingSoon;
  if (req.body?.playUrl !== undefined) {
    const savedPlayUrl = String(req.body.playUrl || '').trim();
    if (savedPlayUrl && !validHttpUrl(savedPlayUrl)) return res.status(400).json({ error: 'Link chơi phải là URL HTTP/HTTPS hợp lệ. Hãy nhập vào ô Link chơi, không phải ô API dữ liệu.' });
    if (savedPlayUrl) {
      config.comingSoon = false;
      // Share the brand link across variants (for example TX + Sicbo) when they use the same brand.
      const brandKey = String(config.brand || config.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      for (const sibling of gameConfigs) {
        const siblingKey = String(sibling.brand || sibling.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (sibling !== config && siblingKey === brandKey) {
          sibling.playUrl = savedPlayUrl;
          sibling.playMode = config.playMode === 'external' ? 'external' : (sibling.playMode || 'embed');
          sibling.comingSoon = false;
        }
      }
    }
  }
  if (req.body?.visible !== undefined) config.visible = req.body.visible !== false;
  if (req.body?.image !== undefined && req.body?.iconUrl === undefined) config.iconUrl = String(req.body.image || '').trim().slice(0, 500);
  if (FEEDS[config.id]) {
    Object.assign(FEEDS[config.id], {
      label: config.label, url: config.url, parser: config.parser, enabled: config.enabled,
      playUrl: config.playUrl || '', table: config.table || '', group: config.group || 'tx',
      historyUrl: config.historyUrl || '', brand: config.brand || config.id, variant: config.variant || '', icon: config.icon || '', iconUrl: config.iconUrl || ''
    });
  }
  saveGameConfigs(); logLine(`game updated: ${config.id}`); res.json({ ok: true, game: config });
});
app.delete('/api/admin/games/:id', requireAdmin, (req, res) => {
  const i = gameConfigs.findIndex(g => g.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Không tìm thấy game.' });
  const [removed] = gameConfigs.splice(i, 1); delete FEEDS[removed.id]; saveGameConfigs(); saveState(); logLine(`game removed: ${removed.id}`); res.json({ ok: true });
});

// ---------- admin: stats, full result/accuracy history, logs ----------
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const games = {};
  for (const [id, f] of Object.entries(FEEDS)) {
    games[id] = { label: f.label, enabled: f.enabled, historyCount: f.history.length, accuracyHistoryCount: f.accuracyHistory.length,
      lastSession: f.lastSession, correct: f.correct, total: f.total, accuracy: f.total ? +(f.correct / f.total * 100).toFixed(1) : null,
      weights: Object.fromEntries(Object.entries(f.engine.weights).map(([m, w]) => [m, +Number(w).toFixed(3)])),
      modelEwma: Object.fromEntries(Object.entries(f.engine.modelHits || {}).map(([m, h]) => [m, { win: h.win, loss: h.loss, ewma: +Number(h.ewma).toFixed(3) }])),
      regime: f.engine.marketState.regime, trend: f.engine.marketState.trend, autocorr: +Number(f.engine.autocorr || 0).toFixed(3), lastError: f.lastError || null };
  }
  res.json({ games, totalKeys: keys.filter(k => k.status !== 'revoked' && !isExpired(k)).length, totalKeysAll: keys.length, pendingRequests: botRequests.filter(r => r.status === 'pending').length });
});
app.get('/api/admin/history', requireAdmin, (req, res) => {
  const f = FEEDS[req.query.game]; if (!f) return res.status(400).json({ error: 'Game không hợp lệ.' });
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 500));
  res.json({ game: req.query.game, history: f.history.slice(0, limit) });
});
app.get('/api/admin/accuracy', requireAdmin, (req, res) => {
  const f = FEEDS[req.query.game]; if (!f) return res.status(400).json({ error: 'Game không hợp lệ.' });
  const limit = Math.min(10000, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const hist = (f.accuracyHistory || []).slice(0, limit);
  const norm = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim().toUpperCase();
    if (!s || s === '—' || s === '-' || s === 'NULL' || s === 'UNDEFINED') return null;
    if (/^(T|TAI|BIG)$/.test(s)) return 'T';
    if (/^(X|XIU|SMALL)$/.test(s)) return 'X';
    return s;
  };
  let hits = 0, miss = 0, skipped = 0;
  const series = [];
  const chrono = hist.slice().reverse();
  let runC = 0, runT = 0;
  for (const row of chrono) {
    if (row.skipped || row.isCorrect === null) { skipped++; continue; }
    const explicit = typeof row.isCorrect === 'boolean' ? row.isCorrect
      : typeof row.hit === 'boolean' ? row.hit
      : typeof row.correct === 'boolean' ? row.correct
      : typeof row.ok === 'boolean' ? row.ok : null;
    const pred = norm(row.predicted ?? row.pred ?? row.prediction);
    const actual = norm(row.actual ?? row.result ?? row.char);
    // Only infer a hit/miss when both sides are present; unknown records are not false misses.
    const h = explicit !== null ? explicit : (pred !== null && actual !== null ? pred === actual : null);
    if (h === null) { skipped++; continue; }
    if (h) hits++; else miss++;
    runT++; if (h) runC++;
    series.push({
      session: row.session || row.phien || null,
      hit: h,
      pred: row.predicted || row.pred || row.prediction || null,
      actual: row.actual || row.result || row.char || null,
      ts: row.ts || row.time || null,
      accPct: runT ? +(runC / runT * 100).toFixed(1) : 0
    });
  }
  const scored = hits + miss;
  res.json({ ok: true, game: req.query.game, correct: hits, total: scored, globalCorrect: f.correct, globalTotal: f.total,
    accuracy: scored ? +(hits / scored * 100).toFixed(1) : null, hits, miss, skipped, scored, series, history: hist });
});
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const id = req.body?.game;
  const ids = id === 'all' ? Object.keys(FEEDS) : [id];
  if (!ids.length || ids.some(k => !FEEDS[k])) return res.status(400).json({ error: 'Game không hợp lệ.' });
  for (const gameId of ids) {
    const f = FEEDS[gameId]; f.engine = new Engine(); f.history = []; f.accuracyHistory = []; f.lastSession = null;
    f.pendingPred = null; f.lastLive = null; f.correct = 0; f.total = 0; f._seen = [];
  }
  saveState(); logLine('reset engine(s): ' + ids.join(',')); res.json({ ok: true });
});
app.get('/api/admin/logs', requireAdmin, (req, res) => {
  try { return res.json({ logs: fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-200) }); }
  catch { return res.json({ logs: [] }); }
});


// ---------- admin: users + orders + broadcast helpers ----------
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const list = Object.values(userProfiles || {}).map(p => ({
    telegramId: p.telegramId,
    name: p.name || '',
    username: p.username || '',
    languageCode: p.languageCode || '',
    isPremium: !!p.isPremium,
    firstSeen: p.firstSeen || null,
    lastSeen: p.lastSeen || null,
    seenCount: p.seenCount || 0,
    lastIp: p.lastIp || '',
    lastKeyLabel: p.lastKeyLabel || '',
    lastGame: p.lastGame || '',
    lastSource: p.lastSource || ''
  })).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  res.json({ ok: true, users: list.slice(0, 1000), total: list.length });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'all');
  let list = Array.isArray(orders) ? orders.slice() : [];
  if (status !== 'all') list = list.filter(o => o.status === status);
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({
    ok: true,
    orders: list.slice(0, 500).map(o => ({
      id: o.id, planId: o.planId, planLabel: o.planLabel, price: o.price,
      durationHours: o.durationHours, telegramId: o.telegramId, status: o.status,
      createdAt: o.createdAt, paidAt: o.paidAt || null, issuedKey: o.status === 'paid' ? o.issuedKey : null
    }))
  });
});

app.post('/api/admin/keys/bulk', requireAdmin, (req, res) => {
  try {
    const n = Math.min(50, Math.max(1, Math.floor(Number(req.body?.count || 1))));
    const hours = Math.max(0, Number(req.body?.durationHours || 24));
    const deviceLimit = Math.max(1, Math.min(20, Number(req.body?.deviceLimit || 3)));
    const labelBase = String(req.body?.label || 'Bulk VIP').slice(0, 80);
    const created = [];
    for (let i = 0; i < n; i++) {
      const r = createKey({
        label: labelBase + ' #' + (i + 1),
        durationHours: hours,
        deviceLimit,
        source: 'admin-bulk',
        static: hours === 0
      });
      created.push({ key: r.plainKey, id: r.record.id, label: r.record.label, expiresAt: r.record.expiresAt });
    }
    res.json({ ok: true, keys: created });
  } catch (e) { res.status(400).json({ error: e.message || 'Bulk create failed' }); }
});

app.post('/api/admin/keys/:id/extend', requireAdmin, (req, res) => {
  const key = keys.find(k => k.id === req.params.id);
  if (!key) return res.status(404).json({ error: 'Không tìm thấy key.' });
  const hours = Math.max(0, Number(req.body?.hours || 0));
  if (req.body?.lifetime === true || hours === 0 && req.body?.lifetime !== false && req.body?.hours === 0) {
    // only set lifetime if explicitly requested
  }
  if (req.body?.lifetime === true) {
    key.expiresAt = null;
    key.static = true;
  } else if (hours > 0) {
    const base = key.expiresAt && key.expiresAt > Date.now() ? key.expiresAt : Date.now();
    key.expiresAt = base + hours * 3600000;
    key.static = false;
  } else {
    return res.status(400).json({ error: 'Cần hours > 0 hoặc lifetime: true' });
  }
  saveKeys();
  res.json({ ok: true, key: publicKeyInfo(key) });
});

// ---------- admin: Telegram sales configuration and review queue ----------
app.get('/api/admin/settings', requireAdmin, (req, res) => res.json({ settings: botSettings, telegramConfigured: !!(process.env.TELEGRAM_BOT_TOKEN || process.env.WEB_BOT_TOKEN), adminsConfigured: !!String(process.env.TELEGRAM_ADMIN_IDS || process.env.ADMIN_IDS || '').trim() }));
app.put('/api/admin/settings', requireAdmin, (req, res) => {
  try { botSettings = normalizeSettings({ ...botSettings, ...(req.body || {}) }); saveBotSettings(); logLine('bot settings updated'); res.json({ ok: true, settings: botSettings }); }
  catch (e) { res.status(400).json({ error: e.message || 'Không lưu được cài đặt.' }); }
});
app.get('/api/admin/requests', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'all');
  const list = status === 'all' ? botRequests : botRequests.filter(r => r.status === status);
  res.json({ requests: list.slice(0, 500).map(publicRequest) });
});
app.get('/api/admin/requests/:id/proof', requireAdmin, async (req, res) => {
  try {
    const request = botRequests.find(r => String(r.id) === String(req.params.id));
    if (!request) return res.status(404).json({ error: 'Không tìm thấy yêu cầu.' });
    const idx = Math.max(0, Number(req.query.index || 0));
    const fileId = (request.proofFileIds && request.proofFileIds[idx]) || request.proofFileId;
    if (!fileId) return res.status(404).json({ error: 'Yêu cầu không có ảnh.' });
    const token = process.env.TELEGRAM_BOT_TOKEN || process.env.WEB_BOT_TOKEN;
    if (!token) return res.status(503).json({ error: 'Bot Telegram chưa được cấu hình.' });
    const metaResp = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(10000) });
    const meta = await metaResp.json().catch(() => ({}));
    if (!meta.ok || !meta.result || !meta.result.file_path) return res.status(502).json({ error: 'Không lấy được ảnh từ Telegram.' });
    const imageResp = await fetch(`https://api.telegram.org/file/bot${token}/${meta.result.file_path}`, { signal: AbortSignal.timeout(15000) });
    if (!imageResp.ok) return res.status(502).json({ error: 'Không tải được ảnh minh chứng.' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', imageResp.headers.get('content-type') || 'image/jpeg');
    res.send(Buffer.from(await imageResp.arrayBuffer()));
  } catch (e) { res.status(502).json({ error: e.message || 'Không tải được ảnh.' }); }
});

app.post('/api/admin/requests/:id/review', requireAdmin, async (req, res) => {
  const approved = req.body?.approved === true;
  const candidate = botRequests.find(r => String(r.id) === String(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Không tìm thấy yêu cầu.' });
  if (approved && candidate.type === 'feedback' && !String((botSettings || {}).feedbackChannelId || '').trim()) {
    return res.status(400).json({ error: 'Hãy nhập ID kênh nhận góp ý trong Hệ thống rồi mới duyệt.' });
  }
  const matchedOrder = candidate.type === 'payment' && candidate.orderId && Array.isArray(orders) ? orders.find(o => String(o.id) === String(candidate.orderId)) : null;
  if (approved && matchedOrder && matchedOrder.status === 'paid') {
    return res.status(409).json({ error: 'Đơn này đã được xác nhận thanh toán và key đã phát tự động. Không duyệt bill lần hai.' });
  }
  const result = reviewRequest(req.params.id, approved, 'web-admin');
  if (!result.ok) return res.status(400).json({ error: result.error });
  if (approved && result.request.type === 'feedback') {
    const cfg = botSettings || {};
    const target = String(cfg.feedbackChannelId || '').trim();
    const safe = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const r = result.request;
    const cap = `🏆 <b>CHIA SẺ TỪ NGƯỜI DÙNG</b>\n━━━━━━━━━━━━━━━━━━━━\n${safe(r.caption || '').slice(0, 1200)}\n\n👤 <b>${safe(r.userName || 'Người dùng')}</b>${r.username ? ` · @${safe(r.username)}` : ''}\n🆔 Telegram ID: <code>${safe(r.telegramId || '')}</code>\n🗓 ${new Date(r.createdAt || Date.now()).toLocaleString('vi-VN')}\n\nToolTungTung · @SunNetWin`;
    try {
      const ids = (result.request.proofFileIds && result.request.proofFileIds.length ? result.request.proofFileIds : [result.request.proofFileId]).filter(Boolean).slice(0, 10);
      if (ids.length > 1) {
        const media = ids.map((file_id, i) => ({ type: 'photo', media: file_id, caption: i === 0 ? cap.replace(/<[^>]*>/g, '') : undefined, parse_mode: i === 0 ? 'HTML' : undefined }));
        await answerTelegram('sendMediaGroup', { chat_id: target, media });
      } else if (ids.length === 1) await answerTelegram('sendPhoto', { chat_id: target, photo: ids[0], caption: cap, parse_mode: 'HTML' });
      else await answerTelegram('sendMessage', { chat_id: target, text: cap, parse_mode: 'HTML' });
      result.request.published = true; result.request.publishedAt = Date.now(); saveRequests();
      if (telegramBot) await telegramBot.sendTextToUser(result.request.telegramId, '✅ Góp ý của bạn đã được duyệt và gửi đến kênh phản hồi. Cảm ơn bạn đã báo lại.').catch(() => null);
    } catch (e) { result.request.status = 'pending'; result.request.reviewedAt = null; result.request.reviewer = ''; saveRequests(); logLine('[feedback] publish failed: ' + String(e.message || 'unknown').slice(0, 300)); return res.status(502).json({ error: 'Chưa đăng được góp ý. Yêu cầu đã trở lại trạng thái chờ để thử lại sau khi kiểm tra bot/kênh.' }); }
  }
  if (approved && result.request.type === 'payment' && result.key && result.request.orderId && Array.isArray(orders)) {
    const related = orders.find(o => String(o.id) === String(result.request.orderId));
    if (related && related.status !== 'paid') {
      related.status = 'paid'; related.paidAt = Date.now(); related.manualApproved = true;
      related.issuedKey = result.key; related.issuedKeyExpiresAt = result.meta && result.meta.expiresAt || null;
      related.reviewedRequestId = result.request.id;
      saveOrders();
    }
  }
  if (approved && result.request.type === 'payment' && String((botSettings || {}).feedbackChannelId || '').trim()) {
    const target = String(botSettings.feedbackChannelId).trim();
    const r = result.request;
    const escHtml = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const caption = `🧾 <b>BILL MUA KEY ĐÃ DUYỆT</b>\nMã yêu cầu: <code>${escHtml(r.id)}</code>\nNgười mua: ${escHtml(r.userName || r.username || 'Người dùng')}\nTelegram ID: <code>${escHtml(r.telegramId)}</code>${r.username ? `\nUsername: @${escHtml(r.username)}` : ''}\nGói: ${escHtml(r.planLabel || r.planId || 'Key')}\nGiá: <b>${Number(r.price || 0).toLocaleString('vi-VN')}đ</b>\nThời hạn: ${Number(r.durationHours || 0)} giờ\nThời gian: ${new Date(r.createdAt || Date.now()).toLocaleString('vi-VN')}\nTrạng thái: Đã duyệt · key đã gửi riêng qua bot\n@SunNetWin`;
    try {
      if (r.proofFileId) await answerTelegram('sendPhoto', { chat_id: target, photo: r.proofFileId, caption, parse_mode: 'HTML' });
      else await answerTelegram('sendMessage', { chat_id: target, text: caption, parse_mode: 'HTML' });
      r.billPublishedAt = Date.now(); saveRequests();
    } catch (e) { logLine('[bill-channel] send failed: ' + String(e.message || 'unknown').slice(0, 300)); }
  }

  if (approved && result.key) {
    if (!telegramBot) return res.status(503).json({ error: 'Bot Telegram chưa được khởi động; key đã tạo nhưng chưa gửi được.' });
    try {
      await telegramBot.sendKeyToUser(result.request.telegramId, result.key, result.meta || {});
      markDelivered(result.request.id);
    } catch (e) { return res.status(502).json({ error: 'Đã duyệt nhưng không gửi được key qua Telegram: ' + e.message }); }
  }
  if (!approved && telegramBot) {
    try { await telegramBot.sendTextToUser(result.request.telegramId, `❌ Yêu cầu #${result.request.id} đã bị từ chối. Vui lòng kiểm tra lại chứng từ hoặc liên hệ admin.`); } catch {}
  }
  res.json({ ok: true, request: publicRequest(result.request) });
});

// ---------- start bot + polling ----------
let telegramBot = null;
if (process.env.TELEGRAM_BOT_TOKEN || process.env.WEB_BOT_TOKEN) {
  telegramBot = startTelegramBot({
    token: process.env.TELEGRAM_BOT_TOKEN || process.env.WEB_BOT_TOKEN,
    adminIds: process.env.TELEGRAM_ADMIN_IDS || process.env.ADMIN_IDS || '',
    getConfig: () => botSettings,
    saveConfig: (cfg) => { botSettings = normalizeSettings(cfg); saveBotSettings(); },
    getSessions, saveSessions, addRequest,
    getRequests: () => botRequests,
    forceSaveRequests: () => saveRequests(),
    getKeys: () => keys,
    saveKeys,
    findKey,
    isExpired,
    createKey: args => createKey(args),
    reviewRequest,
    markDelivered,
  });
} else logLine('Telegram bot disabled: TELEGRAM_BOT_TOKEN is not set.');

setInterval(() => { Promise.all(Object.keys(FEEDS).map(id => pollFeed(id))); }, POLL_MS);
setInterval(saveState, 60000);
Promise.all(Object.keys(FEEDS).map(id => pollFeed(id)));


// ---------- AUTO PAYMENT: VietQR orders + webhook (SePay/Casso/PayOS) ----------
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
let orders = loadJSON(ORDERS_FILE, []);
if (!Array.isArray(orders)) orders = [];
const saveOrders = () => saveJSON(ORDERS_FILE, orders);

function genOrderId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(5);
  let tail = '';
  for (let i = 0; i < 5; i++) tail += alphabet[bytes[i] % alphabet.length];
  return 'TungTung-' + tail;
}

function buildVietQr(amount, addInfo) {
  const cfg = botSettings || {};
  if (!cfg.bankCode || !cfg.bankAccount) return null;
  return 'https://img.vietqr.io/image/' + encodeURIComponent(cfg.bankCode) + '-' + encodeURIComponent(cfg.bankAccount) + '-compact2.jpg?amount=' + encodeURIComponent(String(Math.round(Number(amount)||0))) + '&addInfo=' + encodeURIComponent(addInfo) + '&accountName=' + encodeURIComponent(cfg.bankAccountName || '');
}

async function tgSendMessage(chatId, text, extra) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.WEB_BOT_TOKEN;
  if (!token || !chatId) return false;
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(Object.assign({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true }, extra || {}))
    });
    return r.ok;
  } catch(e) { return false; }
}

async function fulfillOrder(order, transactionRef) {
  if (order.status === 'paid') return order;
  order.status = 'paid'; order.paidAt = Date.now(); order.transactionRef = transactionRef || '';
  const plan = (botSettings.plans || []).find(p => p.id === order.planId);
  const hours = Math.max(1, Number(plan && plan.durationHours || order.durationHours || 24));
  const devices = Math.max(1, Number(plan && plan.deviceLimit || 3));
  const issued = createKey({ label: (plan && plan.label || 'Key') + ' · Auto ' + order.id, durationHours: hours, deviceLimit: devices, source: 'auto-payment', telegramId: order.telegramId || null });
  order.issuedKey = issued.plainKey; order.issuedKeyExpiresAt = issued.record.expiresAt;
  saveOrders(); saveKeys();
  if (order.telegramId) {
    const days = hours >= 24 ? Math.round(hours/24) + ' ngày' : hours + ' giờ';
    await tgSendMessage(order.telegramId,
      '✅ <b>THANH TOÁN THÀNH CÔNG</b>\n────────────────────\n📦 <b>' + (plan && plan.label || 'Key VIP') + '</b> · ⏱ ' + days + '\n🔑 Mã của bạn:\n<code>' + issued.plainKey + '</code>\n\n🎮 Mở tool: ' + (getPublicBase() || '') + '\n💬 @SunNetWin');
  }
  const salesChannel = String((botSettings || {}).feedbackChannelId || '').trim();
  if (salesChannel) {
    const escInfo = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const info = `🧾 <b>ĐƠN KEY ĐÃ THANH TOÁN</b>\nMã đơn: <code>${escInfo(order.id)}</code>\nNgười mua Telegram: <code>${escInfo(order.telegramId || '—')}</code>\nGói: ${escInfo(plan && plan.label || order.planLabel || 'Key')}\nSố tiền: <b>${Number(order.price || 0).toLocaleString('vi-VN')}đ</b>\nThời hạn: ${hours} giờ\nMã giao dịch: <code>${escInfo(transactionRef || '—')}</code>\nTrạng thái: Đã phát key riêng qua bot.\n@SunNetWin`;
    const posted = await tgSendMessage(salesChannel, info);
    if (posted) { order.channelNotifiedAt = Date.now(); saveOrders(); }
    else logLine('[sales-channel] unable to post paid order ' + String(order.id));
  }
  return order;
}

// Tạo đơn hàng từ Mini App → trả VietQR + nội dung CK
app.post('/api/shop/order', (req, res) => {
  const planId = String(req.body && req.body.planId || '').toLowerCase();
  const telegramId = req.body && req.body.telegramId ? String(req.body.telegramId) : null;
  const plan = (botSettings.plans || []).find(p => p.id === planId && p.active !== false);
  if (!plan) return res.status(400).json({ error: 'Gói không tồn tại.' });
  if (!botSettings.bankCode || !botSettings.bankAccount) return res.status(503).json({ error: 'Admin chưa cấu hình ngân hàng VietQR. Dùng /setbank trên bot.' });
  const orderId = genOrderId();
  const order = { id: orderId, planId: planId, planLabel: plan.label, price: Number(plan.price), durationHours: Number(plan.durationHours), deviceLimit: 1, telegramId: telegramId, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 5 * 60 * 1000, content: orderId };
  orders.push(order); if (orders.length > 500) orders.splice(0, orders.length - 500); saveOrders();
  res.json({ ok: true, orderId: orderId, content: orderId, amount: order.price, planLabel: plan.label, durationHours: order.durationHours, deviceLimit: order.deviceLimit,
    qrUrl: buildVietQr(order.price, orderId),
    bank: { code: botSettings.bankCode, account: botSettings.bankAccount, name: botSettings.bankAccountName } });
});

// Kiểm tra trạng thái đơn (Mini App polling)
app.get('/api/shop/order/:id', (req, res) => {
  const o = orders.find(x => x.id === String(req.params.id).toUpperCase());
  if (!o) return res.status(404).json({ error: 'Không tìm thấy đơn.' });
  res.json({ ok: true, orderId: o.id, status: o.status, price: o.price, planLabel: o.planLabel, issuedKey: o.status === 'paid' ? o.issuedKey : null, expiresAt: o.issuedKeyExpiresAt || null, paidAt: o.paidAt || null });
});

// Webhook nhận giao dịch từ SePay / Casso / PayOS → auto phát key
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const rawContent = String(body.content || body.description || body.orderCode || body.addInfo || '').toUpperCase();
    const amount = Number(body.transferAmount || body.amount || body.transfer_amount || 0);
    const ref = String(body.referenceCode || body.id || body.reference || '');
    if (!rawContent || !amount) return res.json({ ok: false, error: 'Thieu noi dung/so tien' });
    const cleanContent = rawContent.replace(/[^A-Z0-9]/g, '');
    let matched = false;
    // 1) Đơn Mini App: TT + 6 ký tự hex
    const orderMatch = cleanContent.match(/TUNGTUNG([A-Z0-9]{5})/) || cleanContent.match(/TT([0-9A-F]{6})/);
    if (orderMatch) {
      const oid = cleanContent.includes('TUNGTUNG') ? ('TungTung-' + orderMatch[1]) : ('TT' + orderMatch[1]);
      const order = orders.find(x => x.id === oid && x.status === 'pending');
      if (order && Math.abs(amount - order.price) < 1000) { await fulfillOrder(order, ref); matched = true; }
    }
    // 2) Luồng bot cũ: KEYVIP + telegramId → auto duyệt payment request
    if (!matched) {
      const kvMatch = cleanContent.match(/KEYVIP(\d+)/);
      if (kvMatch) {
        const tgId = kvMatch[1];
        const reqPay = botRequests.find(r => r.type === 'payment' && r.status === 'pending' && String(r.telegramId) === tgId);
        if (reqPay && Math.abs(amount - Number(reqPay.price || 0)) < 1000) {
          const result = reviewRequest(reqPay.id, true, 'auto-webhook');
          if (result.ok && result.key) {
            await tgSendMessage(tgId, '✅ <b>THANH TOÁN THÀNH CÔNG</b>\n🔑 Mã của bạn:\n<code>' + result.key + '</code>\n\n🎮 Mở tool ngay trong Telegram');
            matched = true;
          }
        }
      }
    }
    res.json({ ok: true, matched: matched });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});


// Auto-fetch key theo Telegram ID (admin duyệt thủ công → Mini App tự nhận key)
app.get('/api/shop/my-key', (req, res) => {
  const tgId = String(req.query.telegramId || '');
  if (!tgId) return res.status(400).json({ ok:false, error:'Thieu telegramId' });
  const approved = botRequests.filter(function(r){ return String(r.telegramId||'')===tgId && r.status==='approved' && r.issuedKey; })
    .sort(function(a,b){ return (b.reviewedAt||0)-(a.reviewedAt||0); });
  if (approved.length) {
    const r = approved[0];
    if (r.issuedKeyExpiresAt && Number(r.issuedKeyExpiresAt) <= Date.now()) {
      return res.json({ ok:true, hasKey:false, reason:'expired' });
    }
    return res.json({ ok:true, hasKey:true, key:r.issuedKey, label:r.planLabel || 'Key VIP', expiresAt:r.issuedKeyExpiresAt || null });
  }
  const pending = botRequests.some(function(r){ return String(r.telegramId||'')===tgId && r.status==='pending'; });
  res.json({ ok:true, hasKey:false, pending:pending });
});


// Lấy danh sách gói key (admin chỉnh trên bot → cửa hàng tự cập nhật)
app.get('/api/shop/plans', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const plans = (botSettings.plans || []).filter(function(p){ return p.active !== false && Number(p.price) > 0 && Number(p.durationHours) > 0; });
  const rawBot = String(botSettings.telegramBotUrl || '').trim();
  const username = String(process.env.TELEGRAM_BOT_USERNAME || botSettings.telegramUsername || '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
  const telegramBotUrl = rawBot || (username ? 'https://t.me/' + username : '');
  res.json({ ok: true, telegramBotUrl, plans: plans.map(function(p){ return { id: String(p.id), label: String(p.label), price: Number(p.price), durationHours: Number(p.durationHours), deviceLimit: Number(p.deviceLimit || 3), hot: !!p.hot, note: String(p.note || '') }; }) });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found', path: req.path });
  res.status(404).type('html').send('<!doctype html><meta charset=utf-8><title>404</title><body style="font-family:sans-serif;padding:40px"><h1>404 Not Found</h1><p>Path: <code>' + String(req.path).replace(/</g,'') + '</code></p><p><a href="/">← Về trang chủ</a></p></body>');
});


// ===== KEY TĨNH (STATIC_KEY env) =====
try {
  const plainStatic = String(process.env.STATIC_KEY || '').trim();
  if (plainStatic && plainStatic.length >= 5) {
    const h = sha256(plainStatic);
    if (!keys.some(k => k.hash === h)) {
      keys.push({
        id: 'static_' + h.slice(0, 10),
        hash: h,
        label: 'Key Tĩnh · ToolTungTung',
        created: Date.now(),
        expiresAt: null,
        deviceLimit: Math.max(1, Math.min(50, Number(process.env.STATIC_KEY_DEVICES || 5))),
        deviceHashes: [],
        status: 'active',
        source: 'static',
        static: true,
        uses: 0,
        lastUsed: null,
        telegramId: null
      });
      saveKeys();
      logLine('seeded STATIC_KEY');
    }
  }
} catch (e) { console.warn('STATIC_KEY seed failed', e.message); }


// Auto-expire pending shop orders (backup for bot timeout)
setInterval(() => {
  try {
    const now = Date.now();
    let changed = false;
    for (const o of orders) {
      if (o.status === 'pending' && o.expiresAt && o.expiresAt <= now) {
        o.status = 'expired';
        changed = true;
      }
    }
    if (changed) saveOrders();
  } catch (e) {}
}, 30000);

app.listen(PORT, () => {
  logLine(`SERVER listening on port ${PORT}; admin password configured=${!!(process.env.ADMIN_PASSWORD || process.env.ADMIN_SECRET)}; games=${Object.keys(FEEDS).length}`);
});
