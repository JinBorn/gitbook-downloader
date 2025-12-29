const puppeteer = require("puppeteer-core");
const fs = require("fs-extra");
const path = require("path");
const { URL } = require("url");
const { createTurndownService, extractPageContent } = require("./html-parser");
const { escapeRegExp, ensureDirectory, writeFile } = require("../utils");
const { Page } = require("puppeteer-core/lib/cjs/puppeteer/index-browser.js");

/**
 * 下载 GitBook 文档
 * @param {string} url GitBook 文档 URL
 * @param {Object} options 配置选项
 * @param {string} options.outputDir 输出目录
 * @param {boolean} options.downloadImages 是否下载图片
 * @param {Object|null} options.auth 认证信息
 * @param {string} options.auth.username 用户名
 * @param {string} options.auth.password 密码
 * @param {Object} options.spinner ora spinner 实例
 */
async function downloadGitbook(url, options) {
  // console.log("打印配置", url, options);
  const {
    all = false,
    outputDir,
    downloadImages = true,
    auth = null,
    spinner,
    concurrency = 4,
  } = options;

  // 确保输出目录存在
  await ensureDirectory(outputDir);

  // 初始化 Turndown 服务
  const turndownService = createTurndownService();

  // 启动浏览器
  spinner.text = "启动浏览器...";
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath:
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", //chrome浏览器地址
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();

    // 添加页面错误监听
    page.on("error", (err) => {
      console.error("页面错误:", err);
    });

    // 添加请求失败监听
    page.on("requestfailed", (request) => {
      console.log(`请求失败: ${request.url()}`);
    });

    // 设置视口大小
    await page.setViewport({ width: 1280, height: 800 });

    // 如果需要认证，先设置 HTTP Basic 认证凭据（用于 HTTP Basic auth），
    // 之后再访问页面；同时保留表单登录的回退逻辑
    if (auth && auth.username && auth.password) {
      spinner.text = "设置 HTTP Basic 认证凭据...";
      await page.authenticate({
        username: auth.username,
        password: auth.password,
      });
    }

    // 访问 URL（带 HTTP/HTTPS 回退与嵌入凭据重试）
    spinner.text = "正在访问文档页面...";
    try {
      await page.goto(url, { waitUntil: "networkidle2" });
    } catch (err) {
      const errMsg = err && err.message ? err.message : "";
      const isProtocolOrAuthError =
        errMsg.includes("ERR_INVALID_AUTH_CREDENTIALS") ||
        errMsg.includes("net::ERR_INVALID_AUTH_CREDENTIALS") ||
        errMsg.includes("ERR_SSL_PROTOCOL_ERROR") ||
        errMsg.includes("ERR_CERT") ||
        errMsg.includes("net::ERR_CERT") ||
        errMsg.includes("ERR_CONNECTION_REFUSED") ||
        errMsg.includes("ERR_CONNECTION_RESET") ||
        errMsg.includes("401") ||
        /401 Authorization Required/i.test(errMsg);

      // 如果是协议/证书/认证相关错误，先尝试切换协议重试，再尝试在 URL 中嵌入凭据重试一次（如果提供了 auth）
      if (isProtocolOrAuthError && /^https?:\/\//i.test(url)) {
        const altUrl = url.startsWith("https://")
          ? url.replace(/^https:\/\//i, "http://")
          : url.startsWith("http://")
            ? url.replace(/^http:\/\//i, "https://")
            : url;

        // 1) 先尝试切换协议重试
        try {
          spinner.text = `导航失败，尝试切换到 ${altUrl} 重试...`;
          await page.goto(altUrl, { waitUntil: "networkidle2" });
          // 如果成功，将 url 更新为重试成功的 URL（后续使用）
          url = altUrl;
        } catch (err2) {
          // 切换协议重试失败，继续尝试使用嵌入凭据（如果提供）
          if (!(auth && auth.username && auth.password)) {
            // 没有凭据可用，抛出原始错误
            throw err;
          }
          // 继续到下面的嵌入凭据逻辑
        }

        // 2) 如果存在认证信息，尝试通过在 URL 中嵌入凭据重试一次（处理 401 情况）
        if (auth && auth.username && auth.password) {
          try {
            // 构建带凭据的 URL（例如 https://user:pass@host/path）
            const protocolMatch = url.match(/^([a-z]+:\/{2})/i);
            const protocol = protocolMatch ? protocolMatch[1] : "";
            const urlWithoutProtocol = url.replace(/^https?:\/\//i, "");
            const credentialSegment = `${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password)}@`;
            const urlWithCreds =
              protocol + credentialSegment + urlWithoutProtocol;

            spinner.text = `尝试使用嵌入凭据导航: ${protocol}//***@${new URL(url).hostname} ...`;
            await page.goto(urlWithCreds, { waitUntil: "networkidle2" });

            // 将 url 更新为成功的带凭据 URL，后续处理会基于这个 URL
            url = urlWithCreds;
          } catch (err3) {
            // 嵌入凭据的重试也失败，抛出原始错误以便上层处理
            throw err;
          }
        } else {
          // 没有凭据可用且协议重试已失败，抛出错误
          throw err;
        }
      } else {
        // 非协议/认证类错误，直接抛出
        throw err;
      }
    }

    // 如果需要认证（表单登录回退）
    if (auth) {
      spinner.text = "尝试进行表单登录（如果存在）...";
      await handleAuthentication(page, url, auth);
    }

    // 等待页面加载完成
    await page.waitForSelector("body", { timeout: 30000 });

    // 获取文档标题
    const title = await page.title();
    spinner.text = `正在处理文档: ${title}`;

    // 判断 URL 是否包含具体路径
    const urlObj = new URL(url);
    const hasPath = urlObj.pathname !== "/" && urlObj.pathname !== "";

    if (hasPath && !all) {
      // 如果包含具体路径，只下载当前页面
      spinner.text = "正在下载单个页面...";
      const content = await extractPageContent(page);
      let markdown = turndownService.turndown(content);

      // 处理图片
      if (downloadImages) {
        const imagesDir = path.join(outputDir, "images");
        await ensureDirectory(imagesDir);
        markdown = await processImages(
          page,
          markdown,
          imagesDir,
          urlObj.pathname,
        );
      }

      // 生成文件名
      const fileName = path.basename(urlObj.pathname) || "index";
      await writeFile(path.join(outputDir, `${fileName}.md`), markdown);
    } else {
      // 如果只有域名，下载整站
      // 解析目录结构
      spinner.text = "正在解析目录结构...";
      const tocStructure = await extractTableOfContents(page);

      // 创建索引文件
      await createIndexFile(outputDir, title, tocStructure);

      // 处理每个页面
      spinner.text = "正在下载文档内容...";
      await processPages(browser, tocStructure, {
        baseUrl: url,
        outputDir,
        downloadImages,
        turndownService,
        spinner,
        auth,
        concurrency,
      });
    }
  } finally {
    // 关闭浏览器
    await browser.close();
  }
}

/**
 * 处理身份认证
 * @param {puppeteer.Page} page 页面实例
 * @param {string} url 文档 URL
 * @param {Object} auth 认证信息
 */
async function handleAuthentication(page, url, auth) {
  // 页面应已加载，这里尝试寻找登录表单（如果存在）
  await page
    .waitForSelector('input[type="email"]', { timeout: 10000 })
    .catch(() => {});

  // 如果找到了登录表单，则进行登录
  const hasLoginForm = (await page.$('input[type="email"]')) !== null;
  console.log("打印是否有登录表单", hasLoginForm);

  if (hasLoginForm) {
    await page.type('input[type="email"]', auth.username);
    await page.type('input[type="password"]', auth.password);
    await page.click('button[type="submit"]');

    // 等待登录完成
    await page.waitForNavigation({ waitUntil: "networkidle2" });
  }
}

/**
 * 提取目录结构
 * 支持新版 GitBook (data-testid="table-of-contents") 以及经典 GitBook (ul.summary)
 * @param {puppeteer.Page} page 页面实例
 * @returns {Array} 目录结构
 */
async function extractTableOfContents(page) {
  return await page.evaluate(() => {
    const tocItems = [];

    // 尝试新版 GitBook 的目录容器
    let tocContainer = document.querySelector(
      '[data-testid="table-of-contents"]',
    );

    // 如果没有找到，再尝试经典 GitBook 的侧边目录 ul.summary
    if (!tocContainer) {
      tocContainer = document.querySelector("ul.summary");
    }

    // 如果仍然没有目录容器则返回空
    if (!tocContainer) return tocItems;

    // 查找所有目录链接项
    const links = tocContainer.querySelectorAll("a[href]");

    links.forEach((link) => {
      let href = link.getAttribute("href") || "";
      const title = link.textContent.trim();

      // 忽略空链接和锚点
      if (!href || href === "#") return;

      // 忽略外部链接
      if (href.startsWith("http")) return;

      // 规范化部分常见相对路径形式：去掉开头的 './'
      if (href.startsWith("./")) href = href.replace(/^\.\//, "");

      // 保证以 '/' 开头（便于后续基于 baseUrl 构造完整 URL）
      if (!href.startsWith("/")) href = "/" + href;

      tocItems.push({
        title,
        url: href,
        level: getElementLevel(link),
      });
    });

    return tocItems;

    // 辅助函数：根据 DOM 层级计算目录项层级（对新版/经典结构都能适用）
    function getElementLevel(element) {
      let level = 1;
      let parent = element.parentElement;

      // 往上走直到达到 tocContainer，统计 li/ul 的深度作为层级依据
      while (parent && parent !== tocContainer) {
        // 每遇到一个 LI 增加一级；遇到 UL 也可视为层级变化（兼容不同主题）
        if (parent.tagName === "LI") {
          level++;
        }
        parent = parent.parentElement;
      }

      // 返回最少为 1 的层级
      return Math.max(1, level);
    }
  });
}

/**
 * 创建索引文件
 * @param {string} outputDir 输出目录
 * @param {string} title 文档标题
 * @param {Array} tocStructure 目录结构
 */
async function createIndexFile(outputDir, title, tocStructure) {
  let indexContent = `# ${title}\n\n## 目录\n\n`;

  // 生成目录内容
  tocStructure.forEach((item) => {
    const indent = "  ".repeat(item.level - 1);
    const link = item.url.replace(/^\//, "") + ".md";
    indexContent += `${indent}- [${item.title}](${link})\n`;
  });

  // 写入索引文件
  await writeFile(path.join(outputDir, "README.md"), indexContent);
}

/**
 * 处理所有页面
 * @param {puppeteer.Browser} browser 浏览器实例
 * @param {Array} tocStructure 目录结构
 * @param {Object} options 配置选项
 */
async function processPages(browser, tocStructure, options) {
  const {
    baseUrl,
    outputDir,
    downloadImages,
    turndownService,
    spinner,
    auth,
    concurrency = 4,
  } = options;
  const baseUrlObj = new URL(baseUrl);

  // 创建图片目录
  const imagesDir = path.join(outputDir, "images");
  if (downloadImages) {
    await ensureDirectory(imagesDir);
  }

  // 辅助：规范化 Markdown 表格（如果表头存在但缺少分隔行，自动插入）
  function normalizeTables(markdown) {
    const lines = markdown.split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      // 如果当前行看起来像表头（包含 | ）并且下一行不是表分隔符但下一行也包含 |
      if (
        lines[i].includes("|") &&
        i + 1 < lines.length &&
        lines[i + 1].includes("|") &&
        !/^\s*\|?\s*:?-{3,}\s*(\|\s*:?-{3,}\s*)*\|?\s*$/.test(lines[i + 1])
      ) {
        // 构建分隔行，依据表头列数
        const cols = lines[i].split("|").length - 1;
        if (cols > 0) {
          const parts = [];
          for (let c = 0; c < cols; c++) parts.push(" --- ");
          const sep = "|" + parts.join("|") + "|";
          out.push(sep);
        }
      }
    }
    return out.join("\n");
  }

  // 单页处理函数，便于并发执行
  async function processItem(index) {
    const item = tocStructure[index];
    spinner.text = `正在处理页面 (${index + 1}/${tocStructure.length}): ${item.title}`;

    // 构建完整 URL
    let pageUrl = new URL(item.url, baseUrlObj).toString();

    // 打开新页面
    const page = await browser.newPage();

    // 如果提供了 HTTP Basic 认证信息，应用到新页面（用于 HTTP Basic auth）
    if (auth && auth.username && auth.password) {
      try {
        await page.authenticate({
          username: auth.username,
          password: auth.password,
        });
      } catch (e) {
        // 某些环境可能不支持 authenticate，忽略错误继续
      }
    }

    // 打开页面，遇到协议/证书/认证类错误时尝试切换协议重试一次
    try {
      await page.goto(pageUrl, { waitUntil: "networkidle2" });
    } catch (err) {
      const errMsg = err && err.message ? err.message : "";
      const isProtocolError =
        errMsg.includes("ERR_INVALID_AUTH_CREDENTIALS") ||
        errMsg.includes("net::ERR_INVALID_AUTH_CREDENTIALS") ||
        errMsg.includes("ERR_SSL_PROTOCOL_ERROR") ||
        errMsg.includes("ERR_CERT") ||
        errMsg.includes("net::ERR_CERT") ||
        errMsg.includes("ERR_CONNECTION_REFUSED") ||
        errMsg.includes("ERR_CONNECTION_RESET");
      if (isProtocolError && /^https?:\/\//i.test(pageUrl)) {
        const altUrl = pageUrl.startsWith("https://")
          ? pageUrl.replace(/^https:\/\//i, "http://")
          : pageUrl.startsWith("http://")
            ? pageUrl.replace(/^http:\/\//i, "https://")
            : pageUrl;
        try {
          spinner.text = `页面导航失败，尝试切换到 ${altUrl} 重试...`;
          await page.goto(altUrl, { waitUntil: "networkidle2" });
          pageUrl = altUrl;
        } catch (err2) {
          console.error(`页面 ${pageUrl} 导航失败：`, err.message || err);
          await page.close();
          return;
        }
      } else {
        console.error(`页面 ${pageUrl} 导航失败：`, err.message || err);
        await page.close();
        return;
      }
    }

    // 等待内容加载完成
    await page.waitForSelector("main", { timeout: 30000 }).catch(() => {});

    // 提取页面内容
    const content = await extractPageContent(page);

    // 转换为 Markdown
    let markdown = turndownService.turndown(content || "");

    // 处理图片
    if (downloadImages) {
      try {
        markdown = await processImages(page, markdown, imagesDir, item.url);
      } catch (e) {
        // 图片下载出错不应阻止文档保存
        console.error("图片处理失败：", e && e.message ? e.message : e);
      }
    }

    // 规范化表格格式，减少错乱
    try {
      markdown = normalizeTables(markdown);
    } catch (e) {
      // 忽略表格规范化错误
    }

    // 检查内容是否为空
    if (!markdown || !markdown.trim()) {
      await page.close();
      return; // 跳过空内容文件
    }

    // 生成文件路径，保持原始目录结构
    const relativePath = item.url.replace(/^\//, "");
    const fileDir = path.join(outputDir, path.dirname(relativePath));
    let fileName;

    // 处理首页文件名，使用域名作为前缀
    if (relativePath === "") {
      const domain = baseUrlObj.hostname;
      fileName = `${domain}.md`;
    } else {
      fileName = path.basename(relativePath) + ".md";
    }

    // 确保目录存在
    await ensureDirectory(fileDir);

    // 写入文件
    try {
      await writeFile(path.join(fileDir, fileName), markdown);
    } catch (e) {
      console.error(
        `写入文件 ${fileName} 失败：`,
        e && e.message ? e.message : e,
      );
    }

    // 关闭页面
    await page.close();
  }

  // 并发执行：基于 concurrency 的工作池
  const total = tocStructure.length;
  const workers = Math.min(concurrency, total);
  const promises = [];
  for (let w = 0; w < workers; w++) {
    promises.push(
      (async function worker(startIndex) {
        let idx = startIndex;
        while (idx < total) {
          await processItem(idx);
          idx += workers;
        }
      })(w),
    );
  }

  await Promise.all(promises);
}

/**
 * 处理图片
 * @param {puppeteer.Page} page 页面实例
 * @param {string} markdown Markdown 内容
 * @param {string} imagesDir 图片目录
 * @param {string} pageUrl 页面 URL
 * @returns {string} 处理后的 Markdown
 */
async function processImages(page, markdown, imagesDir, pageUrl) {
  // 提取 Markdown 中的图片链接
  const imgRegex = /!\[(.*?)\]\((.*?)\)/g;
  let match;
  let processedMarkdown = markdown;

  // 创建页面特定的图片子目录，保持原始目录结构
  const relativePagePath = pageUrl.replace(/^\//, "");
  const pageImagesDir = path.join(imagesDir, path.dirname(relativePagePath));
  await ensureDirectory(pageImagesDir);

  // 当前页面的绝对 URL，作为解析相对图片地址的 base
  const pageCurrentUrl = page.url();

  // 处理每个图片
  const imagePromises = [];
  const imageMap = new Map();
  const downloadResults = new Map();

  while ((match = imgRegex.exec(markdown)) !== null) {
    const [fullMatch, alt, src] = match;

    // 跳过 base64 图片
    if (src.startsWith("data:")) continue;

    // 尝试解析 src 为 URL，如果是相对路径则基于当前页面 URL 解析
    let urlObj = null;
    let resolvedSrc = src;
    try {
      urlObj = new URL(src);
      resolvedSrc = urlObj.toString();
    } catch (e) {
      try {
        // resolve relative to current page
        urlObj = new URL(src, pageCurrentUrl);
        resolvedSrc = urlObj.toString();
      } catch (e2) {
        // 解析失败：保守处理，使用原始 src，并稍后以 basename 作为扩展名来源
        urlObj = null;
        resolvedSrc = src;
      }
    }

    // 生成图片文件名，src 可能包含参数，因此获取扩展名时要移除掉参数
    const ext = (urlObj && path.extname(urlObj.pathname)) || ".png";
    const imgFileName = `image_${Date.now()}_${Math.floor(Math.random() * 1000)}${ext}`;
    const imgPath = path.join(pageImagesDir, imgFileName);
    const relativeImgPath = path
      .join("images", path.dirname(relativePagePath), imgFileName)
      .replace(/\\/g, "/");

    // 保存图片 URL 和本地路径的映射（使用原始 markdown 中的 src 作为键，以便替换原始引用）
    imageMap.set(src, { localPath: relativeImgPath, success: false });

    // 下载图片（传入已解析的 resolvedSrc，以确保 fetch 在页面上下文中能正确请求）
    imagePromises.push(
      page
        .evaluate(async (imgSrc) => {
          try {
            const response = await fetch(imgSrc);
            if (!response.ok) return null;

            // 对于普通图片或 JSON 解析失败的情况，直接使用原始响应
            const blob = await response.blob();
            return await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.readAsDataURL(blob);
            });
          } catch (error) {
            console.error("图片下载错误：", error);
            return null;
          }
        }, resolvedSrc)
        .then(async (base64Data) => {
          if (base64Data) {
            // 从 base64 提取实际数据
            const base64Content = base64Data.split(",")[1];
            if (base64Content) {
              await fs.writeFile(imgPath, Buffer.from(base64Content, "base64"));
              const mapEntry = imageMap.get(src);
              if (mapEntry) mapEntry.success = true;
            }
          }
        }),
    );
  }

  // 等待所有图片下载完成
  await Promise.all(imagePromises);

  // 替换 Markdown 中的图片链接
  imageMap.forEach(({ localPath, success }, originalSrc) => {
    if (success) {
      // 如果图片下载成功，使用本地路径
      processedMarkdown = processedMarkdown.replace(
        new RegExp(
          `!\\[(.*?)\\]\\(${escapeRegExp(originalSrc)}(\\s+".*?")?\\)`,
          "g",
        ),
        `![$1](${localPath})`,
      );
    }
    // 如果下载失败，保留原始链接
  });

  return processedMarkdown;
}

module.exports = {
  downloadGitbook,
};
