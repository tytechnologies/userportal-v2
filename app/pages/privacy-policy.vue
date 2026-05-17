<template>
    <Login />
</template>

<script>

import Login from '~/components/pages/Login'

export default {
    head() {
        return {
            title: "Privacy Policy | Housinginteractive.com.ph"
        }
    },
    layout: 'empty',
    components : { Login }

}

</script>