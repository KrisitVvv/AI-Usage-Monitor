<div align="center">
  <img src="./images/logo.png" alt="Logo" width="120" />
  <h1>AI用量监控 AI-Usage-Monitor</h1>
</div>

## 功能描述 Functional Description
AI用量监控适用于deepseek,Kimi,GLM.Qwen等模型的API调用情况集成监控，方便用户直观了解模型调用情况。  
The AI usage monitor can get deepseek,Kimi,GLM.Qwen and so on model's API usage situation,and display it in a clear and intuitive way.
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
npm run electron:build
```