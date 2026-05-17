<script setup lang="ts">
/**
 * Button — shadcn-style button (Operations palette).
 *
 * Variants:
 *   default     — solid primary fill (the brand action)
 *   secondary   — bordered card surface (the secondary action)
 *   destructive — solid destructive fill
 *   outline     — bordered ghost (neutral, less weight than secondary)
 *   ghost       — bg-only on hover (toolbars / icon buttons)
 *   link        — underline link affordance
 *
 * For app-wide actions, prefer the .btn-primary / .btn-secondary /
 * .btn-ghost / .btn-destructive utility classes from tailwind.css —
 * they share the same look and don't require an import. This
 * component is kept for shadcn-vue / radix-vue interop.
 */
import { cva } from 'class-variance-authority'
import { cn } from '~/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium ring-offset-background transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/95',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/95',
        secondary:
          'border border-border bg-card text-foreground hover:bg-accent hover:border-border-strong',
        outline:
          'border border-border bg-transparent text-foreground hover:bg-accent',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-3.5 py-2',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-10 px-5',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

interface Props {
  variant?: NonNullable<Parameters<typeof buttonVariants>[0]>['variant']
  size?: NonNullable<Parameters<typeof buttonVariants>[0]>['size']
  as?: string
}

// eslint-disable-next-line vue/define-macros-order
withDefaults(defineProps<Props>(), {
  as: 'button',
})
</script>

<template>
  <component
    :is="as"
    :class="cn(buttonVariants({ variant, size }), $attrs.class ?? '')"
  >
    <slot />
  </component>
</template>
