require("dotenv").config();
const got = require("got");
const { spawn } = require("node:child_process");

const INVENTORY_API_URL = "https://uk.coach.com/api/inventory";
const STORE_ORIGIN = "https://uk.coach.com";

const WATCHES = [
    {
        variationGroupId: "CDS58-B4MPL",
        name: "Coach CDS58-B4MPL",
        productPageUrl: `${STORE_ORIGIN}/search?q=CDS58-B4MPL`,
        delayAfterMs: 240000,
    },
];

const lastOrderableByVariationGroupId = new Map();
let shouldExit = false;

function requestShutdown() {
    shouldExit = true;
}

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

function delayChunk(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function delay(delayMs) {
    const chunkMs = 1000;
    let remainingMs = delayMs;
    while (remainingMs > 0 && !shouldExit) {
        const stepMs = Math.min(chunkMs, remainingMs);
        await delayChunk(stepMs);
        remainingMs -= stepMs;
    }
}

const REQUEST_TIMEOUT_MS = 15000;

async function sendPing(body) {
    try {
        const res = await got.post(process.env.PING_URL, {
            json: body,
            responseType: "json",
            timeout: REQUEST_TIMEOUT_MS,
        });
        if (res.body?.success !== true) {
            console.error("Ping rejected:", JSON.stringify(res.body));
            return false;
        }
        return true;
    } catch (err) {
        console.error("Ping request failed:", err.message);
        return false;
    }
}

async function sendStartupPing() {
    const watchedNames = WATCHES.map((watch) => watch.name).join(", ");
    return sendPing({
        message: `Watching: ${watchedNames}`,
        title: "Coach monitor active",
        subtitle: `${WATCHES.length} product(s)`,
        url: STORE_ORIGIN,
    });
}

async function sendInStockPing(watch, inventoryInfo, wasOrderable) {
    const message =
        wasOrderable === false
            ? `${watch.name} is back in stock.`
            : `${watch.name} is in stock.`;

    return sendPing({
        message,
        title: `In stock: ${watch.name}`,
        subtitle: `Stock level: ${inventoryInfo.stockLevel}`,
        url: watch.productPageUrl,
    });
}

const BROWSER_HEADERS = [
    "accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language: en-US,en;q=0.9",
    "cache-control: no-cache",
    "pragma: no-cache",
    "priority: u=0, i",
    'sec-ch-ua: "Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
    "sec-ch-ua-mobile: ?0",
    'sec-ch-ua-platform: "macOS"',
    "sec-fetch-dest: document",
    "sec-fetch-mode: navigate",
    "sec-fetch-site: none",
    "sec-fetch-user: ?1",
    "upgrade-insecure-requests: 1",
    "user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
];

const HTTP_STATUS_MARKER = "\n__HTTP_STATUS__:";

// Requires curl on your PATH.
function curlGetJson(url) {
    const curlArgs = [
        "--silent",
        "--show-error",
        "--max-time",
        String(REQUEST_TIMEOUT_MS / 1000),
        "--write-out",
        `${HTTP_STATUS_MARKER}%{http_code}`,
        "--url",
        url,
        ...BROWSER_HEADERS.flatMap((header) => ["-H", header]),
    ];

    return new Promise((resolve, reject) => {
        const curlProcess = spawn("curl", curlArgs);
        let stdoutText = "";
        let stderrText = "";

        curlProcess.stdout.on("data", (chunk) => (stdoutText += chunk));
        curlProcess.stderr.on("data", (chunk) => (stderrText += chunk));

        curlProcess.on("error", (error) => {
            reject(new Error(`Could not start curl: ${error.message}`));
        });

        curlProcess.on("close", (exitCode) => {
            if (exitCode !== 0) {
                reject(new Error(`curl exited with code ${exitCode}: ${stderrText.trim()}`));
                return;
            }

            const markerIndex = stdoutText.lastIndexOf(HTTP_STATUS_MARKER);
            const bodyText = stdoutText.slice(0, markerIndex);
            const statusCode = Number(stdoutText.slice(markerIndex + HTTP_STATUS_MARKER.length));

            if (statusCode < 200 || statusCode >= 300) {
                const error = new Error(`Unexpected response: ${bodyText.slice(0, 200)}`);
                error.statusCode = statusCode;
                reject(error);
                return;
            }

            try {
                resolve(JSON.parse(bodyText));
            } catch {
                reject(new Error(`Response was not JSON: ${bodyText.slice(0, 200)}`));
            }
        });
    });
}

async function checkOrderable(watch) {
    const inventoryUrl = new URL(INVENTORY_API_URL);
    inventoryUrl.searchParams.set("vgId", watch.variationGroupId);

    try {
        const responseBody = await curlGetJson(inventoryUrl.toString());

        const inventoryInfo = responseBody?.inventory?.inventoryInfo;
        if (!inventoryInfo) {
            console.error(
                `${watch.variationGroupId}: response had no inventory.inventoryInfo`,
            );
            return;
        }

        const isOrderable = inventoryInfo.orderable === true;
        const wasOrderable = lastOrderableByVariationGroupId.get(
            watch.variationGroupId,
        );

        console.log(
            `${new Date().toISOString()} ${watch.variationGroupId}: orderable=${isOrderable} stockLevel=${inventoryInfo.stockLevel}`,
        );

        if (isOrderable && wasOrderable !== true) {
            const pingSent = await sendInStockPing(
                watch,
                inventoryInfo,
                wasOrderable,
            );
            // Leave state unchanged so the next check retries the ping.
            if (!pingSent) return;
        }

        lastOrderableByVariationGroupId.set(watch.variationGroupId, isOrderable);
    } catch (err) {
        const statusCode = err.statusCode;
        console.error(
            `${watch.variationGroupId}: check failed${statusCode ? ` (HTTP ${statusCode})` : ""}:`,
            err.message,
        );
    }
}

async function main() {
    if (!process.env.PING_URL) {
        console.error("PING_URL is not set; add it to .env");
        process.exitCode = 1;
        return;
    }

    if (!(await sendStartupPing())) {
        console.error("Startup ping failed; check PING_URL");
        process.exitCode = 1;
        return;
    }
    console.log("Startup ping sent");

    while (!shouldExit) {
        for (const watch of WATCHES) {
            if (shouldExit) break;
            await checkOrderable(watch);
            if (shouldExit) break;
            await delay(watch.delayAfterMs);
        }
    }
}

main().catch(console.error);
