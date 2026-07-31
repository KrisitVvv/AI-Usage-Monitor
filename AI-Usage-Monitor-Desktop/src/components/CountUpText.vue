<script setup>
import { ref, watch, onUnmounted } from 'vue'

const props = defineProps({
  // 目标数值（原始数字，变化时触发滚动动画）
  value: { type: Number, required: true },
  // 显示格式化函数（默认直接转字符串）
  format: { type: Function, default: (v) => String(v) },
  // 动画时长（毫秒）
  duration: { type: Number, default: 700 }
})

const display = ref(props.value)
let rafId = 0

watch(
  () => props.value,
  (to) => {
    cancelAnimationFrame(rafId)
    const from = display.value
    const start = performance.now()

    const step = (now) => {
      const t = Math.min((now - start) / props.duration, 1)
      // easeOutCubic：先快后慢
      const eased = 1 - Math.pow(1 - t, 3)
      display.value = Math.round(from + (to - from) * eased)
      if (t < 1) {
        rafId = requestAnimationFrame(step)
      }
    }
    rafId = requestAnimationFrame(step)
  }
)

onUnmounted(() => cancelAnimationFrame(rafId))
</script>

<template>
  <span>{{ format(display) }}</span>
</template>
