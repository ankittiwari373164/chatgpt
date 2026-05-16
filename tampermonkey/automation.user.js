// ==UserScript==
// @name         AI Content Automation FINAL
// @namespace    http://tampermonkey.net/
// @version      10.1
// @description  Polls localhost:3000 for a prompt, sends it inside ChatGPT, captures the generated image, sends it back to the backend.
// @author       You
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function () {

    'use strict';

    console.log("[AI Auto] Tampermonkey started");

    let running        = false;
    let lastSavedImage = "";
    let lastTaskId     = null;

    /* ============================
       GET TASK
    ============================ */

    function getTask() {

        return new Promise(resolve => {

            GM_xmlhttpRequest({

                method: "GET",
                url:    "http://localhost:3000/current-task",

                onload: function (response) {

                    try {

                        const data = JSON.parse(response.responseText);
                        resolve(data);

                    } catch (err) {

                        console.log("[AI Auto] JSON parse error", err);
                        resolve(null);
                    }
                },

                onerror: function (err) {

                    console.log("[AI Auto] /current-task error", err);
                    resolve(null);
                }
            });
        });
    }

    /* ============================
       SEARCH CLIENT CHAT (optional)
    ============================ */

    async function searchClient(client) {

        try {

            const searchButton =
                [...document.querySelectorAll('button')]
                    .find(b =>
                        b.innerText.toLowerCase().includes('search')
                    );

            if (searchButton) searchButton.click();
            await sleep(2000);

            const inputs = [...document.querySelectorAll('input')];

            const searchInput = inputs.find(i =>
                i.placeholder &&
                i.placeholder.toLowerCase().includes('search')
            );

            if (!searchInput) {

                console.log("[AI Auto] Search input not found — using default chat");
                return;
            }

            searchInput.focus();
            searchInput.value = client;

            searchInput.dispatchEvent(
                new Event('input', { bubbles: true })
            );

            await sleep(2500);

            const divs = [...document.querySelectorAll('div')];

            const chat = divs.find(d =>
                d.innerText && d.innerText.trim() === client
            );

            if (chat) {

                chat.click();
                console.log("[AI Auto] Client chat opened:", client);

            } else {

                console.log("[AI Auto] Client chat not found — using current chat");
            }

        } catch (err) {

            console.log("[AI Auto] searchClient error", err);
        }
    }

    /* ============================
       SEND PROMPT
    ============================ */

    async function sendPrompt(prompt) {

        const textarea =
            document.querySelector('#prompt-textarea') ||
            document.querySelector('[contenteditable="true"]');

        if (!textarea) {

            console.log("[AI Auto] Textarea not found");
            return;
        }

        textarea.focus();
        textarea.innerHTML =
            `<p>${prompt.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`;

        textarea.dispatchEvent(
            new InputEvent('input', { bubbles: true })
        );

        await sleep(1200);

        textarea.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true
            })
        );

        console.log("[AI Auto] Prompt sent");
    }

    /* ============================
       WAIT FOR LATEST IMAGE
    ============================ */

    function waitForLatestImage(task) {

        return new Promise(resolve => {

            console.log("[AI Auto] Waiting for image…");

            const start = Date.now();
            const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

            const timer = setInterval(async () => {

                if (Date.now() - start > TIMEOUT_MS) {

                    clearInterval(timer);
                    console.log("[AI Auto] Image wait timeout");
                    running = false;
                    return resolve(null);
                }

                const images = [...document.querySelectorAll('img')];

                const valid = images.filter(img => {

                    const rect = img.getBoundingClientRect();
                    return rect.width > 300 && rect.height > 300;
                });

                if (!valid.length) return;

                const latest = valid[valid.length - 1];
                const src    = latest.src;

                if (!src) return;

                if (src.includes("blob:") ||
                    src.includes("avatar") ||
                    src.includes("logo")) return;

                if (lastSavedImage === src) return;

                clearInterval(timer);
                lastSavedImage = src;

                console.log("[AI Auto] Image found:", src.slice(0, 80));

                try {

                    const response = await fetch(src);
                    const blob     = await response.blob();

                    const reader = new FileReader();

                    reader.onloadend = () => {

                        GM_xmlhttpRequest({

                            method:  "POST",
                            url:     "http://localhost:3000/save-post",
                            headers: { "Content-Type": "application/json" },

                            data: JSON.stringify({
                                client:    task.client,
                                prompt:    task.prompt,
                                image:     reader.result,
                                createdAt: new Date().toISOString(),
                                status:    "generated"
                            }),

                            onload: r => {

                                console.log("[AI Auto] Image saved", r.status);
                                running = false;
                                resolve(true);
                            },

                            onerror: err => {

                                console.log("[AI Auto] save-post error", err);
                                running = false;
                                resolve(null);
                            }
                        });
                    };

                    reader.readAsDataURL(blob);

                } catch (err) {

                    console.log("[AI Auto] fetch/save error", err);
                    running = false;
                    resolve(null);
                }

            }, 4000);
        });
    }

    /* ============================
       MAIN LOOP
    ============================ */

    async function startAutomation() {

        if (running) return;

        const task = await getTask();

        if (!task) {

            console.log("[AI Auto] No task");
            return;
        }

        if (task.id === lastTaskId) {

            console.log("[AI Auto] Same task — waiting");
            return;
        }

        lastTaskId = task.id;
        running    = true;

        console.log("[AI Auto] Got task:", task);

        await searchClient(task.client);
        await sleep(3000);

        await sendPrompt(task.prompt);
        await waitForLatestImage(task);
    }

    /* ============================
       UTIL
    ============================ */

    function sleep(ms) {

        return new Promise(r => setTimeout(r, ms));
    }

    /* ============================
       BOOT
    ============================ */

    setInterval(startAutomation, 15000);

})();
