<template>
    <footer class="p-8 bg-card bg-muted">
        
        <div class="flex flex-wrap sm:flex-nowrap md:flex-nowrap lg:no-wrap gap-8 text-center sm:text-left md:text-left lg:text-left">
            <div class="w-full md:w-1/3">
                <LogoLink />
            </div>
            <div class="w-full md:w-1/3">
                <h4 class="font-bold text-sm uppercase mb-6">Get in touch</h4>
                <ul>
                    <li class="flex items-center gap-2 text-foreground mb-4">
                        <font-awesome-icon icon="location-dot" class="text-sm" />
                        <p>6th Flr. LDM Building<br/>Polaris St. Makati City</p>
                    </li>
                    <li class="flex items-center gap-2 text-foreground">
                        <font-awesome-icon icon="phone" class="text-sm" />
                        <p>t: (632) 8809-7574<br/>t: (632) 8809-7574</p>
                    </li>
                </ul>
            </div>
            <div class="w-full md:w-1/3">
                <h4 class="font-bold text-sm uppercase mb-6">Social media</h4>
                <ul class="flex flex-wrap gap-2">
                    <li>                        
                        <a href="#" class="rounded-full w-10 h-10 bg-muted block flex items-center justify-center text-foreground">
                            <font-awesome-icon :icon="['fab', 'facebook-f']" />
                        </a>
                    </li>
                    <li>                        
                        <a href="#" class="rounded-full w-10 h-10 bg-muted block flex items-center justify-center text-foreground">
                            <font-awesome-icon :icon="['fab', 'twitter']" />
                        </a>
                    </li>
                    <li>                        
                        <a href="#" class="rounded-full w-10 h-10 bg-muted block flex items-center justify-center text-foreground">
                            <font-awesome-icon :icon="['fab', 'linkedin-in']" />
                        </a>
                    </li>
                    <li>                        
                        <a href="#" class="rounded-full w-10 h-10 bg-muted block flex items-center justify-center text-foreground">
                            <font-awesome-icon :icon="['fab', 'instagram']" />
                        </a>
                    </li>
                    <li>                        
                        <a href="#" class="rounded-full w-10 h-10 bg-muted block flex items-center justify-center text-foreground">
                            <font-awesome-icon :icon="['fab', 'youtube']" />
                        </a>
                    </li>
                    <li>                        
                        <a href="#" class="rounded-full w-10 h-10 bg-muted block flex items-center justify-center text-foreground">
                            <font-awesome-icon :icon="['fab', 'tiktok']" />
                        </a>
                    </li>
                    <li>                        
                        <a href="#" class="rounded-full w-10 h-10 bg-muted block flex items-center justify-center text-foreground">
                            <font-awesome-icon :icon="['fas', 'envelope']" />
                        </a>
                    </li>
                </ul>
            </div>
        </div>
        <div class="flex flex-col sm:flex-row md:flex-row lg:flex-row justify-between text-xs sm:text-sm md:text-sm lg:text-sm text-muted-foreground pt-8">
            <p>Housinginteractive Inc &copy; copyright 2003 - 2023</p>
            <ul class="flex flex-row gap-2">
                <li><a href="/terms-and-conditions">Terms & condition</a></li>
                <li>|</li>
                <li><a href="/privacy-policy">Privacy policy</a></li>
            </ul>
        </div>
    </footer>
</template>

<script>
import LogoLink from './LogoLink'

import { library } from '@fortawesome/fontawesome-svg-core'

import {
    faEnvelope,
    faLocationDot,
    faPhone
} from '@fortawesome/free-solid-svg-icons'

import {
    faFacebookF,
    faInstagram,
    faLinkedinIn,
    faTiktok,
    faTwitter,
    faYoutube
} from '@fortawesome/free-brands-svg-icons'

library.add(
    faEnvelope,
    faFacebookF,
    faInstagram,
    faLinkedinIn,
    faLocationDot,
    faPhone,
    faTiktok,
    faTwitter,
    faYoutube
)

export default {
    props: {
        theme: {
            type: String,
            default: 'primary',
        },
        show: {
            type: Boolean,
        },
    },
    components: { LogoLink },
    computed: {
        backgroundColorClass() {
            if (this.theme === 'secondary') {
                return 'bg-muted/50'
            }
            return 'bg-card'
        },
    },
}
</script>