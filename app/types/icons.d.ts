declare module 'vue-material-design-icons/*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{ size?: number | string; fillColor?: string; title?: string }>
  export default component
}

declare module 'vue-material-design-icons/*' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{ size?: number | string; fillColor?: string; title?: string }>
  export default component
}
