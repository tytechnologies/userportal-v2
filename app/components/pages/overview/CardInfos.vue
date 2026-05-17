<template>
    <div class="py-[1.5vw] border-t border-gray-401 my-[2vw]">
        <div class="grid grid-cols-3 my-6 gap-6">
            <div class="bg-card border rounded flex justify-between mb-6 max-h-[10vw]" v-for="ad in ads" :key="ad.title">
                <div class="flex flex-col justify-center gap-2 pl-2">
                    <span class="text-lg font-bold">{{ ad.title }}</span>
                    <span class="text-md">{{ ad.description }}</span>
                    <a :href="ad.link" class="text-primary font-bold text-md">{{ ad.linkText }}</a>
                </div>
                <img :src="ad.image" class="w-auto">
            </div>
        </div>
    </div>
</template>

<script setup>
import { ref } from 'vue'

const ads = ref([
    {
        title: 'Asia Relocation',
        description: 'Professionally Managed International Moving solutions',
        image: '/img/ad-samples/ad6.png',
        link: 'https://asia-relocation.com/',
        linkText: 'View website'
    },
    {
        title: 'Talkshop',
        description: 'the best English school in the Philippines, is the leading consultancy and training institute for personal effectiveness and corporate communication',
        image: '/img/ad-samples/ad1.png',
        link: 'https://talkshop.com/',
        linkText: 'View website'
    },
    {
        title: 'Your ad here',
        description: 'Your presentation here',
        image: '/img/ad-samples/ad2.png',
        link: '',
        linkText: 'Get in touch'
    },
    {
        title: 'Your ad here',
        description: 'Your presentation here',
        image: '/img/ad-samples/ad3.png',
        link: '',
        linkText: 'Get in touch'
    },
    {
        title: 'Your ad here',
        description: 'Your presentation here',
        image: '/img/ad-samples/ad4.png',
        link: '',
        linkText: 'Get in touch'
    },
    {
        title: 'Your ad here',
        description: 'Your presentation here',
        image: '/img/ad-samples/ad5.png',
        link: '',
        linkText: 'Get in touch'
    }
])
</script>
