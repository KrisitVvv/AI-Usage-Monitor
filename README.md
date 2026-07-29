<div align="center">
  <img src="./images/logo.png" alt="Logo" width="350" />
  <h1>AI用量监控</h1>
</div>

<div align="center">
  
  [![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
  [![Release](https://img.shields.io/github/v/release/KrisitVvv/AI-Usage-Monitor.svg?style=flat-square)](https://github.com/KrisitVvv/AI-Usage-Monitor/releases/latest)
  
</div>

## 功能描述 Functional Description
AI用量监控适用于Deepseek,Kimi,GLM.Qwen等模型的API调用情况集成监控，方便用户直观了解模型调用情况。  
The AI usage monitor can get Deepseek,Kimi,GLM.Qwen and so on model's API usage situation,and display it in a clear and intuitive way.  
<p align="center"><img width="480" height="350" alt="Image" src="https://github.com/user-attachments/assets/126555e0-15bf-4e19-b291-b64e943daa39" /></p>

**目前支持服务商 Now Supported Providers**
- Deepseek  

## 快速构建 Quick Build
环境要求 Environment Requirements
- Node.js 18+
- npm 8+
- Git
  
使用以下命令拉取Github仓库内容，然后进入项目目录，安装依赖，最后运行项目。  
Use the following commands to clone the Github repository content, then enter the project directory, install dependencies, and finally run the project.
```bash
git clone https://github.com/KrisitVvv/AI-Usage-Monitor.git
cd AI-Usage-Monitor/AI-Usage-Monitor-Desktop/
npm install
npm run electron:dev
```
## 打包发行 Packaging and Distribution
使用以下命令打包项目。  
Use the following commands to build the project.
```bash
npm run build
npm run dist
```
## 快速安装 Quick Installation
在release中下载最新的可执行文件，双击即可安装。  
Download the latest executable file from the release and double-click it to install.
> [!IMPORTANT]
> 安装前务必保证可用磁盘空间至少为500MB。  
> Please make sure that the available disk space is at least 500MB before installation.
