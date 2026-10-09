# Readlater Chrome Extension

本地安装：

1. 在 Chrome 打开 `chrome://extensions/`。
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择项目里的 `extension` 目录，例如：

```text
/path/to/readlater/extension
```

使用：

1. 启动 Readlater，默认地址为 `http://127.0.0.1:3000`。
2. 在扩展设置里填写你的 Readlater 地址；远程部署时填写自己的 HTTPS 域名。
3. 打开想保存的网页。
4. 点击 Readlater 扩展里的「保存当前页面」。

抓取内容：

- 保留纯文本，用于划线、comment 和 AI 消化。
- 同时保存 Markdown，用于阅读展示。
- 识别普通图片、`picture/srcset`、懒加载图片和正文 CSS 背景图；微信图片会由服务端保存到 Readlater 自有存储。
- 保存表格、完整标题层级、嵌套列表和代码块；检测到明显结构丢失时会标记为 `needs_review`。

如果保存时提示登录失败，可以在扩展的「设置」里填网页端 Setup 页面显示的 Bearer Token。
