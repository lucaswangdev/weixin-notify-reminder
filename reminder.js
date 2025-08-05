require('dotenv').config();
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");

// 导入工具函数
const { parseCronExpression, formatActiveDays } = require('./utils/index.js');

// 配置参数（可在 PM2 环境变量中覆盖）
const WECHAT_WEBHOOK_URL = process.env.WECHAT_WEBHOOK_URL || "https://qyapi.weixin.qq.com/cgi-bin/webhook/send";
const WECHAT_WEBHOOK_KEY = process.env.WECHAT_WEBHOOK_KEY;
const WEBHOOK_URL = `${WECHAT_WEBHOOK_URL}?key=${WECHAT_WEBHOOK_KEY}`;
const TIME_ZONE = process.env.TZ || "Asia/Shanghai";
const PORT = process.env.PORT || 3000;

// 验证配置
if (!WECHAT_WEBHOOK_KEY) {
  console.error('❌ 错误: WECHAT_WEBHOOK_KEY 环境变量未设置，请在.env文件中设置环境变量');
  process.exit(1);
}

console.log(`🕒 定时任务启动（时区: ${TIME_ZONE}）`);

// 任务存储文件
const TASKS_FILE = path.join(__dirname, "tasks.json");
let scheduledTasks = new Map();
let app = express();

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/**
 * 发送提醒的函数
 * @param {string} msg 提醒文字
 * @param {array} mobileList 提醒手机号
 * @param {function} premise 自定义前提条件 函数执行结果为false将终止提醒
 * @returns 
 */
async function reminder(msg, mobileList, premise = () => {}) {
  if (premise && !premise()) {
    return
  }
  
  const now = new Date();
  const timestamp = now.toLocaleString("zh-CN", {
    timeZone: TIME_ZONE,
    hour12: false,
  });

  try {
    console.log(`⏰ [${timestamp}] 发送提醒：${msg}；提醒手机号：${mobileList.join('、')}`);

    const response = await axios.post(
      WEBHOOK_URL,
      {
        msgtype: "text",
        text: {
          content: msg,
          mentioned_mobile_list: mobileList,
        },
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 5000, // 5秒超时
      }
    );

    console.log(
      "✅ 发送成功:",
      response.data.errcode === 0 ? "成功" : response.data.errmsg
    );
  } catch (error) {
    console.error(
      "❌ 发送失败:",
      error.response?.data?.errmsg || error.message
    );
  }
}

// 任务管理功能
// 加载任务
function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const data = fs.readFileSync(TASKS_FILE, "utf8");
      return JSON.parse(data);
    }
    return [];
  } catch (error) {
    console.error("❌ 加载任务失败:", error.message);
    return [];
  }
}

// 保存任务
function saveTasks(tasks) {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf8");
    return true;
  } catch (error) {
    console.error("❌ 保存任务失败:", error.message);
    return false;
  }
}

// 任务调度
function scheduleTask(task) {
  if (scheduledTasks.has(task.id)) {
    scheduledTasks.get(task.id).stop();
    scheduledTasks.delete(task.id);
  }

  const job = cron.schedule(task.cron, async () => {
    await reminder(task.message, task.mobileNumbers, () => {
      if (task.activeDays && task.activeDays.length > 0) {
        const today = new Date().getDay();
        const dayMap = [0, 1, 2, 3, 4, 5, 6]; // Sunday to Saturday
        return task.activeDays.includes(dayMap[today]);
      }
      return true;
    });
  }, {
    timezone: TIME_ZONE
  });

  job.start();
  scheduledTasks.set(task.id, job);
  console.log(`✅ 任务已调度: ${task.name} (${task.cron})`);
}

// 取消任务
function unscheduleTask(taskId) {
  if (scheduledTasks.has(taskId)) {
    scheduledTasks.get(taskId).stop();
    scheduledTasks.delete(taskId);
    console.log(`✅ 任务已取消: ${taskId}`);
  }
}

// 加载所有任务并调用cron
function loadAndScheduleTasks() {
  const tasks = loadTasks();
  tasks.forEach(task => {
    if (task.enabled) {
      scheduleTask(task);
    }
  });
  console.log(`📋 已加载 ${tasks.length} 个任务`);
}

// API 路由
// 获取任务列表（必须提供手机号参数）
app.get("/api/tasks", (req, res) => {
  try {
    const { phone } = req.query;
    
    // 验证手机号参数
    if (!phone) {
      return res.status(400).json({ 
        error: '缺少必要参数',
        message: '必须提供手机号参数',
        timestamp: new Date().toISOString()
      });
    }

    const allTasks = loadTasks();
    
    // 按手机号过滤任务
    const filteredTasks = allTasks.filter(task => 
      task.mobileNumbers.includes(phone)
    );

    // 添加任务状态信息
    const enhancedTasks = filteredTasks.map(task => {
      let cronDescription = '';
      
      try {
        // 简单的cron描述
        const cronParts = task.cron.split(' ');
        if (cronParts.length === 5 || cronParts.length === 6) {
          cronDescription = parseCronExpression(task.cron);
        }
      } catch (error) {
        cronDescription = '无法解析的表达式';
      }

      return {
        ...task,
        isActive: scheduledTasks.has(task.id),
        cronDescription,
        mobileNumbersCount: task.mobileNumbers.length,
        activeDaysText: formatActiveDays(task.activeDays),
        createdAtFormatted: new Date(task.createdAt).toLocaleString('zh-CN')
      };
    });

    res.json({
      tasks: enhancedTasks,
      totalTasks: enhancedTasks.length,
      phone: phone,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('获取任务列表失败:', error);
    res.status(500).json({ 
      error: '获取任务列表失败',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});


// 创建任务
app.post("/api/tasks", (req, res) => {
  const { name, message, cron, mobileNumbers, activeDays, enabled = true } = req.body;
  
  if (!name || !message || !cron) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  const tasks = loadTasks();
  const newTask = {
    id: Date.now().toString(),
    name,
    message,
    cron,
    mobileNumbers: mobileNumbers || [],
    activeDays: activeDays || [],
    enabled,
    createdAt: new Date().toISOString()
  };

  tasks.push(newTask);
  
  if (saveTasks(tasks)) {
    if (enabled) {
      scheduleTask(newTask);
    }
    res.json(newTask);
  } else {
    res.status(500).json({ error: "保存任务失败" });
  }
});

// 修改任务
app.put("/api/tasks/:id", (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  const tasks = loadTasks();
  const taskIndex = tasks.findIndex(t => t.id === id);
  
  if (taskIndex === -1) {
    return res.status(404).json({ error: "任务不存在" });
  }

  tasks[taskIndex] = { ...tasks[taskIndex], ...updates, id };
  
  if (saveTasks(tasks)) {
    unscheduleTask(id);
    if (tasks[taskIndex].enabled) {
      scheduleTask(tasks[taskIndex]);
    }
    res.json(tasks[taskIndex]);
  } else {
    res.status(500).json({ error: "更新任务失败" });
  }
});

// 删除任务
app.delete("/api/tasks/:id", (req, res) => {
  const { id } = req.params;
  
  const tasks = loadTasks();
  const filteredTasks = tasks.filter(t => t.id !== id);
  
  if (filteredTasks.length === tasks.length) {
    return res.status(404).json({ error: "任务不存在" });
  }

  if (saveTasks(filteredTasks)) {
    unscheduleTask(id);
    res.json({ message: "任务已删除" });
  } else {
    res.status(500).json({ error: "删除任务失败" });
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 HTTP服务器启动在端口 ${PORT}`);
  console.log(`📱 访问 http://localhost:${PORT} 创建和管理提醒任务`);
});

// 加载并调度现有任务
loadAndScheduleTasks();
