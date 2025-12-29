"use strict";

const TurndownService = require("turndown");
const path = require("path");

/**
 * 创建并配置 Turndown 服务实例
 * - 包含对表格的 DOM->Markdown 转换（比文本后处理更稳健）
 * - 保留常规规则扩展点（可继续增加）
 */
function createTurndownService() {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });

  configureTurndownRules(turndownService);

  return turndownService;
}

/**
 * 为 turndownService 增加自定义规则
 * - 关键：增加基于 DOM 的 table 规则，直接读取表格的 th/td 来输出 Markdown
 * - 其它常见扩展可以在这里加入（如 task list、hint 等）
 */
function configureTurndownRules(turndownService) {
  // 1) 优先用 DOM 方式处理 <table>
  turndownService.addRule("domTable", {
    filter: function (node) {
      return node.nodeName === "TABLE";
    },
    replacement: function (content, node) {
      try {
        // 遍历表格，构建每一行
        const rows = Array.from(node.querySelectorAll("tr"));
        if (!rows.length) return "";

        // 获取第一行 header（优先 th，否则使用第一行的 td）
        const headerRow = rows.find((r) => r.querySelector("th")) || rows[0];
        const headerCells = Array.from(headerRow.querySelectorAll("th, td"));
        const headers = headerCells.map((cell) =>
          normalizeCellText(cell.textContent || ""),
        );

        // 构造 header 和分隔符
        const headerLine = "| " + headers.join(" | ") + " |";
        const sepLine = "| " + headers.map(() => "---").join(" | ") + " |";

        // 处理剩余行（若 header 使用了第一行，需要从 rows[1] 开始）
        const startIndex =
          headerRow === rows[0] && headerRow.querySelector("th")
            ? 1
            : headerRow === rows[0]
              ? 1
              : 0;
        const bodyRows = rows.slice(startIndex);

        const bodyLines = bodyRows.map((r) => {
          const cells = Array.from(r.querySelectorAll("th, td"));
          // 如果当前行单元格数少于 header，补空格；如果多则全部输出
          const texts = headers.map((_, idx) => {
            const cell = cells[idx];
            return normalizeCellText(cell ? cell.textContent || "" : "");
          });
          return "| " + texts.join(" | ") + " |";
        });

        const md = [headerLine, sepLine].concat(bodyLines).join("\n") + "\n\n";
        return md;
      } catch (e) {
        // 出错回退到 turndown 的默认处理（content）
        return "\n" + (content || "") + "\n";
      }

      function normalizeCellText(text) {
        // 去除多余空白，替换竖线以避免破坏 Markdown 表格
        return String(text || "")
          .replace(/\r?\n+/g, " ")
          .replace(/\|/g, "\\|")
          .trim();
      }
    },
  });

  // 2) 保留图片的默认规则，但可以在这里微调（此处不覆盖，extractPageContent 会产出合适的 img src）
  // 3) 处理代码块（保留 fenced）
  turndownService.addRule("fencedCodeBlock", {
    filter: function (node) {
      return (
        (node.nodeName === "PRE" && node.querySelector("code")) ||
        (node.classList && node.classList.contains("group/codeblock"))
      );
    },
    replacement: function (content, node) {
      const codeElement = node.querySelector("code");
      if (!codeElement) return "";
      const code = codeElement.textContent.replace(/^\n+|\n+$/g, "");
      // 尝试从类名或属性中获取语言标记（容错）
      let lang = "";
      if (codeElement.className) {
        const m = String(codeElement.className).match(/language-(\w+)/);
        if (m) lang = m[1];
      }
      return "\n```" + (lang || "") + "\n" + code + "\n```\n";
    },
  });

  // 4) 简化列表中多余的空行（常见问题）
  turndownService.addRule("compactLists", {
    filter: ["ul", "ol"],
    replacement: function (content) {
      return (
        "\n" +
        String(content)
          .trim()
          .split("\n")
          .filter((l) => l.trim())
          .join("\n") +
        "\n"
      );
    },
  });

  // 5) 虽然我们做了 DOM 清洗，仍然移除孤立的 script/style 文本节点以防万一
  turndownService.addRule("removeScriptStyle", {
    filter: function (node) {
      return node.nodeName === "SCRIPT" || node.nodeName === "STYLE";
    },
    replacement: function () {
      return "";
    },
  });

  // 你可以在这里继续新增规则（hint、任务列表、表格美化等）
}

/**
 * 提取页面内容
 * - 在页面上下文（page.evaluate）中先做 DOM 清理（移除 script/style、移除内联事件、移除页面插件 DOM）
 * - 然后从主内容容器中提取标题、副标题与正文 HTML（尽量干净）
 *
 * 返回值：HTML 字符串（已做部分清理，适合直接交给 Turndown 转为 Markdown）
 */
async function extractPageContent(page) {
  return await page.evaluate(() => {
    /**
     * 清理策略（在浏览器端执行）
     * - 移除 <script>、<style>、<noscript>
     * - 移除 link[rel=preload|stylesheet]（仅当其为内联或会影响抓取时）
     * - 移除带有 data-* 的统计/插件节点（常见插件类名）
     * - 移除所有 inline event attributes（onclick/onerror/...）
     * - 移除常见广告/计数器/外部插件 (class/id 可扩展)
     */

    // helper: remove node safely
    function removeNode(node) {
      if (!node) return;
      try {
        node.parentNode && node.parentNode.removeChild(node);
      } catch (e) {
        /* ignore */
      }
    }

    // 1) 移除 script/style/noscript
    const removeSelectors = [
      "script",
      "style",
      "noscript",
      'link[rel="import"]',
    ];
    removeSelectors.forEach((sel) => {
      Array.from(document.querySelectorAll(sel)).forEach(removeNode);
    });

    // 2) 移除常见第三方插件/计数器/无关元素（可继续扩展）
    const pluginSelectors = [
      ".pageview-count",
      ".gitbook-plugin-pageview-count",
      ".hit-counter",
      ".analytics",
      ".ad",
      ".adsbygoogle",
      "#pageview",
      ".page-footer .count",
    ];
    pluginSelectors.forEach((sel) => {
      Array.from(document.querySelectorAll(sel)).forEach(removeNode);
    });

    // 3) 去除带有特定名称的 iframes（计数器/外部）
    Array.from(document.querySelectorAll("iframe")).forEach((iframe) => {
      const src = (iframe.getAttribute && iframe.getAttribute("src")) || "";
      if (!src) {
        removeNode(iframe);
        return;
      }
      // 移除明显的统计/第三方 iframe（关键词匹配）
      if (/count|analytics|google-analytics|track|pixel/i.test(src))
        removeNode(iframe);
    });

    // 4) 删除所有元素的内联事件属性（onclick, onerror, onmouseover, ...）
    const allElements = Array.from(document.querySelectorAll("*"));
    const eventAttrRE = /^on/i;
    allElements.forEach((el) => {
      // copy attributes list first to avoid实时修改影响遍历
      const attrs = Array.from(el.attributes || []);
      attrs.forEach((attr) => {
        if (eventAttrRE.test(attr.name)) {
          try {
            el.removeAttribute(attr.name);
          } catch (e) {}
        }
      });
    });

    // 5) 删除 HTML 注释（避免注释中包含脚本）
    (function removeComments(node) {
      for (let i = 0; i < node.childNodes.length; i++) {
        const cn = node.childNodes[i];
        if (cn.nodeType === Node.COMMENT_NODE) {
          node.removeChild(cn);
          i--;
        } else if (cn.nodeType === Node.ELEMENT_NODE) {
          removeComments(cn);
        }
      }
    })(document.documentElement);

    // 6) 查找主内容容器（多策略）
    const mainSelectors = [
      "main",
      ".book-body",
      "#book",
      ".page",
      ".page-inner",
      ".content",
      ".markdown-section",
      ".article",
      "#content",
    ];
    let mainContent = null;
    for (const s of mainSelectors) {
      mainContent = document.querySelector(s);
      if (mainContent) break;
    }
    // 兜底使用 body
    if (!mainContent) mainContent = document.body;

    // 7) 针对经典 GitBook 的 sidebar summary（提取目录所需的锚）——这里不移除
    // 8) 进一步清理 mainContent：移除空的注释、ARIA-only nodes、script/style inside
    Array.from(
      mainContent.querySelectorAll(
        "script, style, noscript, .ads, .toc-plugin",
      ),
    ).forEach(removeNode);

    // 9) 移除不必要属性（class、data-*）以减小输出噪音（保留 href/src 等）
    function stripAttributes(root) {
      // 更保守的属性清理：保留 class/style，以免破坏页面原有样式/结构；
      // 仅移除可能影响无障碍或含噪的属性（aria-*）以及不重要的 data-* 属性
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT,
        null,
        false,
      );
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach((node) => {
        try {
          // 保留 class 和 style
          Array.from(node.attributes || []).forEach((attr) => {
            try {
              if (/^aria-/i.test(attr.name)) {
                node.removeAttribute(attr.name);
              } else if (
                /^data-/.test(attr.name) &&
                !/^(data-src|data-href|data-?original)/i.test(attr.name)
              ) {
                // 移除大多数 data-* 噪声属性，但保留常用的 data-src/data-href 等
                node.removeAttribute(attr.name);
              }
            } catch (e) {
              /* ignore attribute removal errors */
            }
          });
        } catch (e) {
          /* ignore traversal errors */
        }
      });
    }
    stripAttributes(mainContent);

    // 10) 标题、副标题、正文抽取
    const titleEl =
      mainContent.querySelector("h1") || document.querySelector("h1") || null;
    const titleHTML = titleEl ? titleEl.outerHTML : "";

    // 副标题：尝试常见选择器
    const subtitleSelectors = [
      "p.subtitle",
      ".subtitle",
      ".description",
      "p.lead",
      ".page-description",
    ];
    let subtitleHTML = "";
    for (const s of subtitleSelectors) {
      const el = mainContent.querySelector(s) || document.querySelector(s);
      if (el) {
        subtitleHTML = `<p class="subtitle">${el.textContent.trim()}</p>`;
        break;
      }
    }

    // 内容：优先找具体容器
    const contentSelectors = [
      ".markdown-section",
      ".book-content",
      ".content",
      ".page-inner",
      "article",
      "#content",
    ];
    let contentEl = null;
    for (const s of contentSelectors) {
      const el = mainContent.querySelector(s) || document.querySelector(s);
      if (el) {
        contentEl = el;
        break;
      }
    }
    if (!contentEl) contentEl = mainContent;

    // 11) 对图片等资源做小处理：把相对 src 变为绝对（基于 location）
    Array.from(contentEl.querySelectorAll("img")).forEach((img) => {
      try {
        const src = img.getAttribute("src") || "";
        if (src && src.startsWith("//")) {
          img.setAttribute("src", (window.location.protocol || "http:") + src);
        } else if (src && src.startsWith("/")) {
          img.setAttribute("src", window.location.origin + src);
        }
      } catch (e) {
        /* ignore */
      }
    });

    // 11.1) 针对性移除已知的搜索/结果 widget（更保守：仅删除明确的 widget 元素，不删除孤立文本节点）
    (function removeSearchWidgets(root) {
      // 仅删除具有明确搜索控件特征的元素：[role="search"], 包含 input/textarea 的容器，或第三方自动完成 widget
      try {
        const targetSelectors = [
          '[role="search"]',
          ".algolia-autocomplete",
          ".algolia-docsearch",
          ".algolia-search",
          ".search-widget",
          ".search-plugin",
        ];
        targetSelectors.forEach((sel) => {
          Array.from(root.querySelectorAll(sel)).forEach((n) => {
            try {
              // 如果容器中有可交互的输入控件或明显是第三方搜索 widget，则移除
              const hasInput =
                n.querySelector("input, textarea, button") !== null;
              const isAlgolia = /algolia|docsearch/i.test(
                (n.className || "") + " " + (n.id || ""),
              );
              if (hasInput || isAlgolia) {
                n.parentNode && n.parentNode.removeChild(n);
              }
            } catch (e) {
              /* ignore individual removal errors */
            }
          });
        });
      } catch (e) {
        /* ignore selector lookup errors */
      }

      // 额外：对于某些主题可能在 page-footer/summary 中包含计数节点，
      // 仅在这些节点的文本完全匹配常见计数标签时才移除，避免误删正文中的相似文本
      try {
        const footerCounts = Array.from(
          root.querySelectorAll(
            ".page-footer .count, .page-footer .pageview-count, .count",
          ),
        );
        footerCounts.forEach((el) => {
          const t = (el.textContent || "").trim();
          if (/^\d+(\s+views?)?$/i.test(t) || /^views?\s*:\s*\d+$/i.test(t)) {
            try {
              el.parentNode && el.parentNode.removeChild(el);
            } catch (e) {}
          }
        });
      } catch (e) {
        /* ignore */
      }
    })(contentEl);

    // 12) Finally, return cleaned HTML (只返回所需部分)
    return `${titleHTML}\n${subtitleHTML}\n${contentEl.innerHTML || ""}`;
  });
}

module.exports = {
  createTurndownService,
  extractPageContent,
};
