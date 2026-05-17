<template>
    <div>
        <table class="min-w-full leading-normal">
            <tbody>
                <tr v-for="(item, index) in data" :key="index">
                    <td class="px-5 py-5 border-b border-gray-402 bg-card text-sm">

                        <div class="w-10 h-10">
                            <img class="w-full h-full rounded-full"
                                src="https://img.icons8.com/ios/200/user-male-circle.png" alt="" />
                        </div>
                    </td>
                    <td class="px-5 py-5 border-b border-gray-402 bg-card text-sm">
                        <p>
                            <span class="font-bold">{{ item.name }}</span> on
                            <span class="italic text-primary uppercase">{{ item.property.name }}</span>
                        </p>
                        <p class="font-bold">{{ item.email }} | {{ item.phone }}</p>
                        <p>{{ item.created_at }}</p>
                        <p class="mt-1">{{ item.message }}</p>
                        <button type="button" class="w-20 mt-1 h-6 my-auto bg-green hover:bg-green-dark rounded-lg">
                            <span class="inline-block text-white text-base font-bold"> Reply </span>
                        </button>
                    </td>
                    <td class="px-5 py-5 border-b border-gray-402 bg-card text-sm">
                        <div class="float-right">
                            <div class="h-7 ml-12">
                                <div class="h-7 px-1.5 pt-1.5 rounded-lg">
                                    <input type="checkbox" id="category-sales" name="category" class="hidden"
                                        v-model="isDelete" value="1" />
                                    <label for="category-sales" class="flex cursor-pointer">
                                        <span class="w-4 h-4 block border mr-2" :class="
                            isDelete
                              ? 'bg-blue border-blue shadow-checkbox'
                              : 'border-gray-401'
                          "></span>
                                    </label>
                                </div>
                            </div>
                            <button type="button" class="w-20 ml-8 h-6 my-auto bg-green hover:bg-green-dark rounded-lg"
                                v-if="isDelete">
                                <span class="inline-block text-white text-base font-bold mt-0.5">
                                    Delete
                                </span>
                            </button>
                        </div>
                    </td>


                </tr>

            </tbody>
        </table>
    </div>
</template>

<script>
    export default {
        props: {
            data: {
                type: Object | Array,
                required: false,
            },
        },
        data() {
            return {
                isDelete: false,
                counter: 1,
            }
        },
        methods: {},
        mounted() { },
    }
</script>