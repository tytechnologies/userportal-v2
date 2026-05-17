<template>
    <aside class="sticky top-0 flex flex-col flex-shrink-0 h-screen transition-all duration-300 bg-card border-r border-border"
        :class="{ 'w-14 hidden sm:block md:block lg:block': !isSidebarOpen, 'px-2': isSidebarOpen }">
        <div class="flex py-4">
            <LogoFull v-show="isSidebarOpen" />
            <Logo class="m-auto" v-show="!isSidebarOpen" />

        </div>
        <ul class="pb-6">
            <li class="flex items-center w-full px-8 pt-2 pl-2 text-sm tracking-normal cursor-pointer leadh-16 ring-3 focus:outline-none"
                v-for="(link, idx) in links" v-bind:key="idx">
                <NuxtLink v-if="!!link.name" :to="{ name: link.name }" :key="link.name"
                    class="rounded-lg px-3.5 py-2 font-bold text-base transition-all duration-300 whitespace-nowrap"
                    :class="
                link.name === $route.name
                ? `bg-primary/10 text-primary w-auto`
                : `hover:bg-muted w-auto`
                ">
                    <font-awesome-icon class="mt-1 left-8" :icon="link.icon" />
                    <span v-show="isSidebarOpen" class="ml-4 transition-all duration-500">{{ link.text }}</span>
                </NuxtLink>
                <a v-else href="#"
                    class="ml-2 px-3.5 py-2 font-bold text-sm hover:bg-muted transition-all duration-50">{{ link.text
                    }}</a>
            </li>
        </ul>
    </aside>
</template>

<script>
    import Account from 'vue-material-design-icons/Account.vue'
    import AccountOutline from 'vue-material-design-icons/AccountOutline.vue'
    import LogoLink from './LogoLink'
    import Magnify from 'vue-material-design-icons/Magnify.vue'
    import Dropdown from '~/components/Dropdown'
    import Logo from '~/components/svg/Logo'
    import LogoFull from '~/components/svg/LogoFull'

    export default {
        props: {
            links: {
                type: Array,
                default: [],
            },
            theme: {
                type: String,
                default: 'primary',
            },
            isSidebarOpen: {
                type: Boolean,
                default: false,
            }
        },
        components: {
            Account,
            AccountOutline,
            LogoLink,
            Magnify,
            Dropdown,
            Logo,
            LogoFull
        },
        data() {
            return {
                filters: {
                    search: '',
                },
                searchColumn: '',
                form: {
                    min_price: '',
                    max_price: '',
                    bedroom: '',
                },
                show: false,
                sample: {
                    id: 'Residential',
                    name: 'Listing Name',
                    location: {
                        columns: ['city.name', 'area.name', 'building.name'],
                        label: 'Location',
                    },
                    display_name: {
                        columns: ['id', 'area.name', 'building.name'],
                        label: 'Display Name',
                        is_visible: true,
                    },
                    'user.name': 'Contact Person',
                },
                sample1: {
                    id: 'price',
                    name: 'Listing Name',
                    location: {
                        columns: ['city.name', 'area.name', 'building.name'],
                        label: 'Location',
                    },
                    display_name: {
                        columns: ['id', 'area.name', 'building.name'],
                        label: 'Display Name',
                        is_visible: true,
                    },
                    'user.name': 'Contact Person',
                },
                errors: {
                    min_price: 'error min_price',
                },
            }
        },
        methods: {
            async logout() {
                await this.$auth.logout()
                await this.$router.push({
                    name: 'home',
                })
            },
            closeUserOptions() {
                this.showUserOptions = false
            },
        },
    }
</script>