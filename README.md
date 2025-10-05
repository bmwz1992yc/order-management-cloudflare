# 订单管理系统 (Cloudflare Workers)

一个基于 Cloudflare 生态系统的无服务器订单管理系统。用户可以上传手写订单的图片，系统使用 AI 模型将图像数据解析为结构化 JSON，并将数据存储在 Cloudflare R2 中。

## 功能特点

- **无服务器架构**: 基于 Cloudflare Workers 构建
- **AI 驱动**: 集成 Google Gemini 或 OpenAI API 进行图像识别和数据提取
- **对象存储**: 使用 Cloudflare R2 存储订单数据和上传的图片
- **响应式前端**: 单页面应用，支持订单查看、编辑和导出功能

## 技术栈

- **后端**: Cloudflare Worker (JavaScript)
- **前端**: Vanilla JavaScript + HTML + CSS (单文件应用)
- **数据库**: Cloudflare R2
- **AI 服务**: Google Gemini 或 OpenAI API

## 快速开始

1. 克隆项目
2. 安装依赖: `npm install`
3. 配置 Cloudflare: `wrangler.toml`
4. 启动开发服务器: `wrangler dev`

## 部署

使用 Cloudflare Wrangler 部署:
```bash
wrangler deploy
```

## 许可证

MIT
