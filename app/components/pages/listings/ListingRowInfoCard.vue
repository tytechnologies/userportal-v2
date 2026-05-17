<template>
<div class="flex gap-3">
    <div class="flex items-end justify-end w-14 h-14 rounded p-2 bg-center bg-contain" :style="{ 'backgroundImage': 'url(' + getThumbnail + ')' }">
        <span v-show="showOnlineStatus"
            class="font-bold cursor-pointer hover:underline w-4 h-4 rounded-full block"
            :class="getClass"
            @click="changeListingOnlineStatus(index, row.id, !row.is_online)">&nbsp;</span>
    </div>
    <div>
        <div>
            <a :href="getUrl(row.url)" class="cursor-pointer text-foreground font-bold text-base leading-4" target="_blank">{{ unitNumberWithBuilding }}</a>
        </div>
        <div>
            <span v-if="row.is_for_sale">
                Sale
            </span>
            <span v-if="row.is_for_sale && row.is_for_rent"> • </span>
            <span v-if="row.is_for_rent">
                Rent
            </span>
        </div>
        <div class="text-xs font-bold text-muted-foreground">
            <span class="w-4 h-4 rounded bg-primary/10 p-1">ID</span> {{ row.id }}
        </div>
    </div>
</div>
</template>

<script>

export default {
   
    props : {
        index : {
                type : Number,
                default : null
            },
        row : {
                type : Object,
                default : {}
            },
        showOnlineStatus : {
                type : Boolean,
                default : false
            }
    },

    computed : {
        getThumbnail() {
            return this.row.thumbnail == '' ? 'https://dummyimage.com/64x64/2f7eed/ffffff.jpg&text=No+Image' : this.row.thumbnail
        },

        getClass() {
            return this.row.is_online ? 'bg-success' : 'bg-destructive';
        },

        unitNumberWithBuilding() {            
            return this.row.building_name 
                    ? 
                    `${this.row.unit_number} - ${this.row.building_name}`
                    :
                    this.row.unit_number;      
        }
    },

    methods : {
        changeListingOnlineStatus(index, id, isOnline)
        {
            this.$emit('changeListingOnlineStatus', index, id, isOnline);
        },

        getUrl(url){
            return `https://stellular-medovik-c6e02e.netlify.app${url}`
        },  
    }
};
</script>
